import { MockSapClient, type SapMasterSource } from '@oat/sap'

/**
 * Resolve the SAP client for this deployment.
 *
 * We have no tenant yet (assumption A2), so `mock` is the only implementation. The point of
 * routing every caller through here is that adding the real OData client is a config change
 * plus one new branch — not a hunt through call sites.
 */
export function sapMasterSource(): SapMasterSource {
  const mode = process.env.OAT_SAP_CLIENT ?? 'mock'

  switch (mode) {
    case 'mock':
      return new MockSapClient()
    default:
      // Fail loudly rather than silently falling back to the mock: a production deployment
      // that thinks it is talking to SAP but is actually reading fixtures would quietly
      // produce a fictional asset register.
      throw new Error(`Unknown OAT_SAP_CLIENT "${mode}". Supported: mock`)
  }
}
