import { ingestUnresolved, SnmpConnector, type UnresolvedSignal } from '@oat/connectors'
import type { PrismaClient } from '@oat/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SnmpModule } from './snmp'
import { EmulatedPrinter } from '../testing/emulated-printer'

/**
 * The SNMP proof (Phase 3 / GATE 3): the collector's SNMP module, over the wire, against an
 * emulated printer with a RISING page counter, produces a real utilisation delta.
 *
 * This is the whole point of the collector made concrete: a real SNMP GET to a real (emulated)
 * device, the page counter advancing between two polls, and the module turning that delta into
 * a `utilisation busy:true` signal — presence on the first sight, work on the second. The
 * emulator is a pure-Node net-snmp agent (no Docker/Python), so this runs everywhere CI runs.
 */

const PORT = 16610 // distinctive, to avoid clashing with the connectors' snmpd integration test
const TAG = 'LAB-0005'

let printer: EmulatedPrinter

async function waitUntilReachable(timeoutMs = 3000): Promise<boolean> {
  const probe = new SnmpConnector({
    targets: [{ assetRef: 'PROBE', host: '127.0.0.1', port: PORT }],
    timeoutMs: 500,
    retries: 0,
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await probe.poll()).length > 0) return true
  }
  return false
}

beforeAll(async () => {
  printer = new EmulatedPrinter({ port: PORT, initialPageCount: 1000 })
  const up = await waitUntilReachable()
  if (!up) throw new Error('emulated printer did not come up')
})

afterAll(() => {
  printer.close()
})

describe('SnmpModule against an emulated printer', () => {
  function module(): SnmpModule {
    return new SnmpModule({ targets: [{ assetRef: TAG, host: '127.0.0.1', port: PORT }], timeoutMs: 2000, retries: 0 })
  }

  it('reports presence (heartbeat), not activity, on first sight', async () => {
    const signals = await module().collect()

    expect(signals).toHaveLength(1)
    // First read has no baseline: reachable is not busy (ADR-0008).
    expect(signals[0]).toMatchObject({ externalRef: TAG, source: 'snmp', type: 'heartbeat' })
    expect(signals[0]).not.toHaveProperty('assetId')
  })

  it('produces a real utilisation delta when the page counter advances between polls', async () => {
    const m = module() // one module instance, so it holds the page-count baseline across polls

    const first = await m.collect()
    expect(first[0]).toMatchObject({ type: 'heartbeat' })

    // A real print job: the emulated printer's lifetime counter moves.
    printer.printPages(7)

    const second = await m.collect()
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ externalRef: TAG, source: 'snmp', type: 'utilisation', value: { busy: true } })
  })

  it('goes back to heartbeat when the counter is flat between polls', async () => {
    const m = module()
    await m.collect() // baseline
    // No printPages() call — nothing printed.
    const again = await m.collect()
    expect(again[0]).toMatchObject({ type: 'heartbeat' })
  })

  it('the collected signal resolves against a KNOWN asset and is never created when unknown', async () => {
    const m = module()
    await m.collect()
    printer.printPages(3)
    const signals = await m.collect()
    const util = signals.find((s) => s.type === 'utilisation')
    expect(util).toBeDefined()

    // Cloud side, KNOWN asset: ingested against the resolved id.
    const knownPrisma = mockPrisma({ [TAG]: 'asset-known' })
    const known = await ingestUnresolved(knownPrisma.prisma, [util as UnresolvedSignal])
    expect(known.accepted).toBe(1)
    expect(known.unmatched).toEqual([])
    expect(knownPrisma.assetCreate).not.toHaveBeenCalled()

    // Cloud side, UNKNOWN asset: reported, never created (ADR-0009).
    const ghostPrisma = mockPrisma({})
    const ghost = await ingestUnresolved(ghostPrisma.prisma, [{ ...(util as UnresolvedSignal), externalRef: 'GHOST' }])
    expect(ghost.unmatched).toEqual(['GHOST'])
    expect(ghost.accepted).toBe(0)
    expect(ghostPrisma.assetCreate).not.toHaveBeenCalled()
  })
})

function mockPrisma(known: Record<string, string>) {
  const assetCreate = vi.fn()
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
  const prisma = {
    asset: {
      findFirst: vi.fn(async ({ where }: { where: { OR: Array<{ tag?: string }> } }) => {
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
  return { prisma, assetCreate, createMany }
}
