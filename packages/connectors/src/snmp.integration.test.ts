import { describe, expect, it } from 'vitest'
import { OIDS, SnmpConnector, SnmpError } from './snmp'

/**
 * Exercised against a REAL snmpd, not a mock.
 *
 * SNMP has enough protocol behaviour that a hand-written fake would mostly prove I can
 * predict my own assumptions: OctetStrings arrive as Buffers, absent OIDs come back as
 * `noSuchObject` varbinds rather than errors, and an unreachable host times out rather than
 * refusing. Every one of those is a thing this adapter has to get right, and none of them
 * are visible against a stub.
 *
 * Start the agent with:
 *   docker run --rm -d --name oat-snmpd -p 1161:161/udp polinux/snmpd
 *
 * Skipped automatically when it is not running, so `pnpm test` stays runnable without
 * Docker. CI starts it — see the workflow.
 */

const HOST = process.env.OAT_TEST_SNMP_HOST ?? '127.0.0.1'
const PORT = Number(process.env.OAT_TEST_SNMP_PORT ?? 1161)

async function agentIsUp(): Promise<boolean> {
  const connector = new SnmpConnector({
    targets: [{ assetRef: 'PROBE', host: HOST, port: PORT }],
    timeoutMs: 1500,
    retries: 0,
  })
  const raws = await connector.poll()
  return raws.length > 0
}

const up = await agentIsUp()

describe.skipIf(!up)('SnmpConnector against a real agent', () => {
  function connector(assetRef = 'LAB-0005') {
    return new SnmpConnector({ targets: [{ assetRef, host: HOST, port: PORT }], timeoutMs: 3000 })
  }

  it('reads the standard MIB-II OIDs a real agent answers', async () => {
    const raws = await connector().poll()

    expect(raws).toHaveLength(1)
    const reading = raws[0]!.payload as Record<string, unknown>

    // A real agent's sysDescr is a free-text string; sysUpTime is ticks since boot.
    expect(typeof reading.sysDescr).toBe('string')
    expect(String(reading.sysDescr).length).toBeGreaterThan(0)
    expect(typeof reading.upTimeTicks).toBe('number')
    expect(reading.upTimeTicks as number).toBeGreaterThan(0)
  })

  it('decodes OctetStrings, which arrive as Buffers not strings', async () => {
    // The kind of thing a stub written from the docs gets silently wrong.
    const raws = await connector().poll()
    const reading = raws[0]!.payload as Record<string, unknown>

    expect(reading.sysName).not.toBeInstanceOf(Buffer)
    expect(typeof reading.sysName).toBe('string')
  })

  it('survives an agent that does not implement the Printer MIB', async () => {
    // snmpd is not a printer: it answers sysDescr and returns noSuchObject for pageCount.
    // A conformant agent reports that per-varbind rather than failing the whole request, and
    // reading it as an error would make every non-printer device look unreachable.
    const raws = await connector().poll()
    const reading = raws[0]!.payload as Record<string, unknown>

    expect(reading.pageCount).toBeUndefined()
    // The rest of the reading still came through.
    expect(reading.sysDescr).toBeDefined()
  })

  it('reports presence, not activity, for a device with no page counter', async () => {
    const c = connector()
    const raws = await c.poll()

    const signal = c.normalise(raws[0]!, 'asset-1')
    // Answering a walk is being reachable, not being busy (ADR-0008).
    expect(signal.type).toBe('heartbeat')
    expect(signal.source).toBe('snmp')
  })

  it('skips an unreachable host without failing the sweep', async () => {
    const mixed = new SnmpConnector({
      targets: [
        { assetRef: 'DEAD', host: '127.0.0.1', port: 1 },
        { assetRef: 'LAB-0005', host: HOST, port: PORT },
      ],
      timeoutMs: 1500,
      retries: 0,
    })

    const raws = await mixed.poll()

    // The live device still reported. One dead printer must not cost us the sweep.
    expect(raws.map((r) => r.externalRef)).toEqual(['LAB-0005'])
  })

  it('times out rather than hanging on a black-hole host', async () => {
    const dead = new SnmpConnector({
      // 203.0.113.0/24 is TEST-NET-3: reserved, routable nowhere, so packets vanish.
      targets: [{ assetRef: 'GONE', host: '203.0.113.1' }],
      timeoutMs: 1200,
      retries: 0,
    })

    const started = Date.now()
    await expect(dead.poll()).resolves.toEqual([])
    // A hung sweep would stall the scheduler behind it.
    expect(Date.now() - started).toBeLessThan(8000)
  })
})

describe('SnmpConnector page-count semantics', () => {
  /** Drives normalise() directly — the counter logic needs no agent. */
  function reading(assetRef: string, pageCount?: number) {
    return {
      externalRef: assetRef,
      observedAt: new Date(),
      payload: { assetRef, pageCount, observedAt: new Date(), sysName: 'printer' },
    }
  }

  it('claims no activity on first sight, having no baseline', async () => {
    const c = new SnmpConnector({ targets: [] })

    // We genuinely do not know what happened before we started watching. Treating the first
    // reading as work would invent activity out of a restart.
    expect(c.normalise(reading('LAB-0005', 5000), 'a1').type).toBe('heartbeat')
  })

  it('reports activity when the page counter has moved', async () => {
    const c = new SnmpConnector({ targets: [] })

    c.normalise(reading('LAB-0005', 5000), 'a1')
    const signal = c.normalise(reading('LAB-0005', 5003), 'a1')

    // Three pages printed: the only real evidence a printer did work.
    expect(signal.type).toBe('utilisation')
    expect(signal.value).toEqual({ busy: true })
  })

  it('reports no activity when the counter is unchanged', async () => {
    const c = new SnmpConnector({ targets: [] })

    c.normalise(reading('LAB-0005', 5000), 'a1')
    expect(c.normalise(reading('LAB-0005', 5000), 'a1').type).toBe('heartbeat')
  })

  it('does not invent activity when the counter goes backwards', async () => {
    const c = new SnmpConnector({ targets: [] })

    c.normalise(reading('LAB-0005', 5000), 'a1')
    // The printer was reset, or the counter wrapped. Either way it is not evidence of work,
    // and a naive delta would read a reboot as a burst of printing.
    expect(c.normalise(reading('LAB-0005', 12), 'a1').type).toBe('heartbeat')
  })

  it('tracks devices independently', async () => {
    const c = new SnmpConnector({ targets: [] })

    c.normalise(reading('LAB-0005', 5000), 'a1')
    c.normalise(reading('LAB-0011', 900), 'a2')

    // LAB-0011's counter moved; LAB-0005's did not. One printer's work is not another's.
    expect(c.normalise(reading('LAB-0011', 902), 'a2').type).toBe('utilisation')
    expect(c.normalise(reading('LAB-0005', 5000), 'a1').type).toBe('heartbeat')
  })

  it('treats an agent with no page counter as presence forever, never as busy', async () => {
    const c = new SnmpConnector({ targets: [] })

    expect(c.normalise(reading('SWITCH-1'), 'a1').type).toBe('heartbeat')
    expect(c.normalise(reading('SWITCH-1'), 'a1').type).toBe('heartbeat')
  })
})

describe('snmpConfigFromEnv', () => {
  it('parses TAG@host:port targets', async () => {
    const { snmpConfigFromEnv } = await import('./snmp')

    const config = snmpConfigFromEnv({ OAT_SNMP_TARGETS: 'LAB-0005@10.1.2.3,LAB-0011@10.1.2.4:1161' })
    expect(config?.targets).toEqual([
      { assetRef: 'LAB-0005', host: '10.1.2.3' },
      { assetRef: 'LAB-0011', host: '10.1.2.4', port: 1161 },
    ])
  })

  it('returns null when unconfigured, so the mock is used', async () => {
    const { snmpConfigFromEnv } = await import('./snmp')

    expect(snmpConfigFromEnv({})).toBeNull()
    expect(snmpConfigFromEnv({ OAT_SNMP_TARGETS: '' })).toBeNull()
    // Garbage that yields no usable target is the same as unconfigured.
    expect(snmpConfigFromEnv({ OAT_SNMP_TARGETS: 'nonsense' })).toBeNull()
  })
})

describe('SnmpError', () => {
  it('names the host it failed to read', () => {
    expect(new SnmpError('10.1.2.3: timeout').message).toContain('10.1.2.3')
  })

  it('exposes the OIDs it reads, so a device can be checked by hand', () => {
    // `snmpget -v2c -c public <host> 1.3.6.1.2.1.1.1.0` should answer for any real device.
    expect(OIDS.sysDescr).toBe('1.3.6.1.2.1.1.1.0')
    expect(OIDS.pageCount).toBe('1.3.6.1.2.1.43.10.2.1.4.1.1')
  })
})
