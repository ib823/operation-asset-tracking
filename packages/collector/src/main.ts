/**
 * The on-LAN collector process (ADR-0021) — `pnpm --filter @oat/collector start`.
 *
 * Runs on a customer LAN. It collects from local sources (SNMP / sweep / osquery), normalises
 * with the SHARED connector logic, and pushes outbound to cloud OAT. It holds NO database
 * connection — by design, which is what makes it structurally unable to create an asset. If you
 * see this process open a Postgres socket, something is very wrong.
 *
 * Phase 2 scaffolds the process: it loads and reports its configuration and heartbeat. The
 * collection modules (Phase 3) and the outbound push loop (Phase 4) build on this skeleton.
 */
import { configProblems, enabledModules, loadCollectorConfig } from './config'
import { HealthReporter } from './health'

/** The OAT host only — never the token, never a full credentialed URL. Safe to log. */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(invalid OAT_URL)'
  }
}

function main(): void {
  const config = loadCollectorConfig()
  const modules = enabledModules(config)
  const collectorId = config.channel?.collectorId ?? '(unenrolled)'

  console.log(`[collector] starting — id=${collectorId}`)
  console.log(
    `[collector]   OAT target: ${config.channel ? safeHost(config.channel.oatUrl) : '(not configured)'} (outbound HTTPS only)`,
  )
  console.log(`[collector]   modules: ${modules.join(', ') || 'none configured'}`)
  console.log(`[collector]   poll interval: ${Math.round(config.pollIntervalMs / 1000)}s`)

  const problems = configProblems(config)
  if (problems.length > 0) {
    console.warn('[collector] not ready to collect:')
    for (const p of problems) console.warn(`[collector]   - ${p}`)
  }

  const health = new HealthReporter(collectorId, modules)
  console.log(health.heartbeatLine())

  // The collect→push loop is wired in Phase 3 (modules) and Phase 4 (channel). Until then the
  // process reports its configuration and exits, rather than idling and looking busy.
  console.log('[collector] scaffold ready. Collection loop lands in Phase 3/4.')
}

main()
