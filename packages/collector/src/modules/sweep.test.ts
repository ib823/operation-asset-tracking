import { ingestUnresolved, type UnresolvedSignal } from '@oat/connectors'
import type { PrismaClient } from '@oat/db'
import { describe, expect, it, vi } from 'vitest'
import { SweepModule, type HostProbe } from './sweep'

/**
 * The sweep discovers identity hints and must NEVER create an asset. These tests pin both: it
 * returns hints only for hosts that answered, and even when a hint's identity is pushed all the
 * way through the cloud's ingest path, an unknown reference is reported, never registered.
 */

/** A deterministic probe: these hosts answer with an identity, everything else is silent. */
function fakeProbe(answers: Record<string, { sysName?: string; sysDescr?: string }>): HostProbe {
  return async (host) => answers[host] ?? null
}

describe('SweepModule.discover', () => {
  it('returns identity hints only for hosts that answered', async () => {
    const probe = fakeProbe({
      '10.1.2.1': { sysName: 'printer-a', sysDescr: 'Brother' },
      '10.1.2.2': { sysName: 'switch-x' },
    })
    const sweep = new SweepModule('10.1.2.0/29', probe)

    const hints = await sweep.discover()

    expect(hints).toEqual([
      { address: '10.1.2.1', sysName: 'printer-a', sysDescr: 'Brother' },
      { address: '10.1.2.2', sysName: 'switch-x' },
    ])
  })

  it('treats a probe that throws as a host that did not answer', async () => {
    const probe: HostProbe = async (host) => {
      if (host === '10.1.2.2') throw new Error('icmp unreachable')
      return host === '10.1.2.1' ? { sysName: 'printer-a' } : null
    }
    const hints = await new SweepModule('10.1.2.0/29', probe).discover()
    expect(hints.map((h) => h.address)).toEqual(['10.1.2.1'])
  })

  it('probes every usable host in the range', async () => {
    const seen: string[] = []
    const probe: HostProbe = async (host) => {
      seen.push(host)
      return null
    }
    await new SweepModule('10.1.2.0/30', probe).discover()
    expect(seen).toEqual(['10.1.2.1', '10.1.2.2'])
  })

  it('NEVER creates an asset — a discovered identity that matches nothing is reported, not registered', async () => {
    // The strongest form of the invariant: take what the sweep found and push it through the
    // exact cloud ingest path a collector would use. An unknown ref must go to `unmatched`, and
    // no asset-creating call may fire (ADR-0009).
    const probe = fakeProbe({ '10.1.2.1': { sysName: 'UNKNOWN-DEVICE-42' } })
    const hints = await new SweepModule('10.1.2.0/30', probe).discover()

    const assetCreate = vi.fn()
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
    const prisma = {
      asset: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
        create: assetCreate,
        update: vi.fn(),
      },
      signalEvent: { createMany, findMany: vi.fn(async () => []) },
      idleConfig: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient

    // A hint carries an identity, not a signal. The most an operator flow could do is submit it
    // as an externalRef — which resolves to nothing.
    const asRefs: UnresolvedSignal[] = hints.map((h) => ({
      externalRef: h.sysName ?? h.address,
      source: 'snmp',
      type: 'heartbeat',
      value: {},
      observedAt: '2026-07-20T10:00:00.000Z',
    }))

    const result = await ingestUnresolved(prisma, asRefs)

    expect(result.unmatched).toEqual(['UNKNOWN-DEVICE-42'])
    expect(result.accepted).toBe(0)
    expect(assetCreate).not.toHaveBeenCalled()
    expect(createMany).not.toHaveBeenCalled()
  })
})
