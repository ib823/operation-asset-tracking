import snmp from 'net-snmp'

/**
 * A tiny in-process SNMP v2c "printer" for tests and demos — DEMO/TEST ONLY, never shipped.
 *
 * It stands in for a real network printer with no Docker, no Python, no external network: a
 * pure-Node net-snmp agent that answers exactly the four OIDs the OAT SNMP connector GETs, and
 * whose `prtMarkerLifeCount` (RFC 3805, `1.3.6.1.2.1.43.10.2.1.4.1.1`) can be advanced to
 * simulate pages printed. Two reads with an advance between them produce a real page-count
 * DELTA over the wire — the only real evidence a printer did work (ADR-0008). This is the
 * "tiny in-repo Node net-snmp agent" option the collector brief allows for the emulated device.
 *
 * It is imported only by tests (and, optionally, a demo script); it is not part of the
 * collector's runtime surface and not exported from the package index.
 */

const MaxAccess = snmp.MaxAccess as unknown as Record<string, number>
const RO = MaxAccess['read-only']!
const NA = MaxAccess['not-accessible']!

/** OIDs served, matching `@oat/connectors` `OIDS` and the RFC citations in REFERENCES.md. */
const PRT_MARKER_ENTRY = '1.3.6.1.2.1.43.10.2.1'

export interface EmulatedPrinterOptions {
  port?: number
  community?: string
  sysDescr?: string
  sysName?: string
  /** Starting lifetime page count. */
  initialPageCount?: number
}

export class EmulatedPrinter {
  readonly port: number
  readonly community: string
  private readonly agent: ReturnType<typeof snmp.createAgent>
  private pageCount: number

  constructor(options: EmulatedPrinterOptions = {}) {
    this.port = options.port ?? 1662
    this.community = options.community ?? 'public'
    this.pageCount = options.initialPageCount ?? 1000

    this.agent = snmp.createAgent({ port: this.port, address: '127.0.0.1', disableAuthorization: false }, () => {})
    this.agent.getAuthorizer().addCommunity(this.community)
    const mib = this.agent.getMib()

    const scalar = (name: string, oid: string, type: number, value: string | number) => {
      mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO })
      mib.setScalarValue(name, value)
    }
    scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, options.sysDescr ?? 'OAT Emulated Printer')
    scalar('sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, 4242)
    scalar('sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, options.sysName ?? 'oat-emulated-printer')

    // prtMarkerLifeCount is a table cell, not a scalar: instance [hrDeviceIndex=1, markerIndex=1]
    // makes the full OID `<entry>.4.1.1`, exactly what the connector reads.
    mib.registerProvider({
      name: 'prtMarkerEntry',
      type: snmp.MibProviderType.Table,
      oid: PRT_MARKER_ENTRY,
      tableColumns: [
        { number: 1, name: 'hrDeviceIndex', type: snmp.ObjectType.Integer, maxAccess: NA },
        { number: 2, name: 'prtMarkerIndex', type: snmp.ObjectType.Integer, maxAccess: NA },
        { number: 4, name: 'prtMarkerLifeCount', type: snmp.ObjectType.Counter, maxAccess: RO },
      ],
      tableIndex: [{ columnNumber: 1 }, { columnNumber: 2 }],
    })
    mib.addTableRow('prtMarkerEntry', [1, 1, this.pageCount])
  }

  /** Simulate `pages` pages printed, so the next read observes a rising counter. */
  printPages(pages: number): void {
    this.pageCount += pages
    this.agent.getMib().setTableSingleCell('prtMarkerEntry', 4, [1, 1], this.pageCount)
  }

  currentPageCount(): number {
    return this.pageCount
  }

  close(): void {
    // net-snmp's agent exposes the listener as `.listener`; closing it frees the UDP port so a
    // test can start a fresh printer without a port clash.
    const listener = (this.agent as unknown as { listener?: { close?: () => void } }).listener
    listener?.close?.()
  }
}
