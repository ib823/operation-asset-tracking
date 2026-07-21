import type { PrismaClient } from '@oat/db'
import { describe, expect, it, vi } from 'vitest'
import { collectUnresolved, ingestUnresolved, UnresolvedSignal } from './pipeline'
import type { Connector } from './types'
import type { RawSignal, SignalInput } from '@oat/core'

/**
 * The collector split (ADR-0021).
 *
 * `collectUnresolved` runs on the LAN (no database); `ingestUnresolved` runs in the cloud and
 * is OAT's IRE — it resolves a ref to a KNOWN asset or reports it, and never creates one. These
 * tests pin both halves, and in particular the never-create invariant that the whole collector
 * design rests on.
 */

/** A tiny connector whose `normalise` ignores `assetId`, like every real adapter. */
function fakeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'snmp',
    pollIntervalMinutes: 15,
    normalise(raw: RawSignal, assetId: string): SignalInput {
      return {
        assetId,
        source: 'snmp',
        type: 'utilisation',
        value: { busy: true },
        observedAt: raw.observedAt,
        dedupeKey: `snmp:${raw.externalRef}:${raw.observedAt.toISOString()}`,
      }
    },
    ...overrides,
  }
}

const RAW = (ref: string): RawSignal => ({
  externalRef: ref,
  observedAt: new Date('2026-07-20T10:00:00.000Z'),
  payload: { any: 'thing' },
})

describe('collectUnresolved (collector side)', () => {
  it('normalises raws into wire-shaped unresolved signals carrying externalRef, not assetId', () => {
    const out = collectUnresolved(fakeConnector(), [RAW('LAB-0005')])

    expect(out).toHaveLength(1)
    const s = out[0]!
    expect(s.externalRef).toBe('LAB-0005')
    expect(s).not.toHaveProperty('assetId')
    expect(s.source).toBe('snmp')
    expect(s.type).toBe('utilisation')
    // observedAt is an ISO string so it survives JSON over the wire.
    expect(s.observedAt).toBe('2026-07-20T10:00:00.000Z')
    expect(typeof s.observedAt).toBe('string')
  })

  it('produces output that validates against the UnresolvedSignal wire schema (round-trip)', () => {
    const out = collectUnresolved(fakeConnector(), [RAW('LAB-0005'), RAW('LAB-0011')])
    for (const s of out) {
      expect(() => UnresolvedSignal.parse(s)).not.toThrow()
    }
  })

  it('drops a reading this connector cannot normalise, keeping the rest of the batch', () => {
    const connector = fakeConnector({
      normalise(raw: RawSignal, assetId: string): SignalInput {
        if (raw.externalRef === 'BAD') throw new Error('unparseable payload')
        return {
          assetId,
          source: 'snmp',
          type: 'heartbeat',
          value: {},
          observedAt: raw.observedAt,
        }
      },
    })

    const out = collectUnresolved(connector, [RAW('LAB-0005'), RAW('BAD'), RAW('LAB-0011')])
    expect(out.map((s) => s.externalRef)).toEqual(['LAB-0005', 'LAB-0011'])
  })
})

/**
 * A mock Prisma for the cloud side.
 *
 * `asset.findFirst` (used by resolveAssetByRef) returns an id for KNOWN refs and null otherwise.
 * `asset.findUnique` (used by reprojection) returns null so re-projection safely no-ops — the
 * point under test is resolution + attachment + the never-create branch, not the idle engine,
 * which has its own suite.
 */
function mockPrisma(known: Record<string, string>) {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
  const assetCreate = vi.fn()
  const prisma = {
    asset: {
      findFirst: vi.fn(async ({ where }: { where: { OR: Array<{ tag?: string; sapAssetNo?: string }> } }) => {
        const ref = where.OR[0]?.tag
        const id = ref ? known[ref] : undefined
        return id ? { id } : null
      }),
      findUnique: vi.fn(async () => null),
      create: assetCreate,
      update: vi.fn(),
    },
    signalEvent: { createMany, findMany: vi.fn(async () => []) },
    idleConfig: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient
  return { prisma, createMany, assetCreate }
}

const wire = (ref: string): UnresolvedSignal => ({
  externalRef: ref,
  source: 'snmp',
  type: 'utilisation',
  value: { busy: true },
  observedAt: '2026-07-20T10:00:00.000Z',
  dedupeKey: `snmp:${ref}:2026-07-20T10:00:00.000Z`,
})

describe('ingestUnresolved (cloud side / IRE)', () => {
  it('resolves a known ref and ingests the signal against the resolved asset id', async () => {
    const { prisma, createMany } = mockPrisma({ 'LAB-0005': 'asset-1' })

    const result = await ingestUnresolved(prisma, [wire('LAB-0005')])

    expect(result.accepted).toBe(1)
    expect(result.unmatched).toEqual([])
    // The signal was written against the RESOLVED asset id, not the external ref.
    const written = createMany.mock.calls[0]![0].data as Array<{ assetId: string; observedAt: Date }>
    expect(written[0]!.assetId).toBe('asset-1')
    // observedAt was re-hydrated from ISO string to a Date.
    expect(written[0]!.observedAt).toBeInstanceOf(Date)
  })

  it('NEVER creates an asset for an unknown ref — reports it as unmatched instead (ADR-0009)', async () => {
    const { prisma, createMany, assetCreate } = mockPrisma({}) // nothing known

    const result = await ingestUnresolved(prisma, [wire('GHOST-9999')])

    expect(result.unmatched).toEqual(['GHOST-9999'])
    expect(result.accepted).toBe(0)
    // The two ways an asset could be created — both must be untouched.
    expect(assetCreate).not.toHaveBeenCalled()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('splits a mixed batch: known refs ingested, unknown refs reported, none created', async () => {
    const { prisma, assetCreate } = mockPrisma({ 'LAB-0005': 'asset-1' })

    const result = await ingestUnresolved(prisma, [wire('LAB-0005'), wire('GHOST-9999')])

    expect(result.accepted).toBe(1)
    expect(result.unmatched).toEqual(['GHOST-9999'])
    expect(assetCreate).not.toHaveBeenCalled()
  })

  it('resolves each distinct ref once, caching within the batch', async () => {
    const { prisma } = mockPrisma({ 'LAB-0005': 'asset-1' })
    const findFirst = prisma.asset.findFirst as unknown as ReturnType<typeof vi.fn>

    await ingestUnresolved(prisma, [wire('LAB-0005'), wire('LAB-0005'), wire('LAB-0005')])

    expect(findFirst).toHaveBeenCalledTimes(1)
  })
})
