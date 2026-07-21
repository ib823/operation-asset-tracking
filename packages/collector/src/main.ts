/**
 * The on-LAN collector process (ADR-0021) — `pnpm --filter @oat/collector start`.
 *
 * Runs on a customer LAN. It collects from local sources (SNMP / sweep / osquery), normalises
 * with the SHARED connector logic, and pushes outbound to cloud OAT. It holds NO database
 * connection — by design, which is what makes it structurally unable to create an asset. If you
 * see this process open a Postgres socket, something is very wrong.
 */
import { OatChannel } from './channel'
import { startLoop } from './collector'
import { configProblems, enabledModules, loadCollectorConfig } from './config'
import { HealthReporter } from './health'
import { buildModules } from './modules'

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
  const modules = buildModules(config)
  const moduleIds = enabledModules(config)
  const collectorId = config.channel?.collectorId ?? '(unenrolled)'

  console.log(`[collector] starting — id=${collectorId}`)
  console.log(
    `[collector]   OAT target: ${config.channel ? safeHost(config.channel.oatUrl) : '(not configured)'} (outbound HTTPS only)`,
  )
  console.log(`[collector]   modules: ${moduleIds.join(', ') || 'none configured'}`)
  console.log(`[collector]   poll interval: ${Math.round(config.pollIntervalMs / 1000)}s`)

  const problems = configProblems(config)
  for (const p of problems) console.warn(`[collector]   ! ${p}`)

  const channel = config.channel ? new OatChannel(config.channel) : null
  const health = new HealthReporter(collectorId, moduleIds)

  if (moduleIds.length === 0) {
    // Nothing to collect: report and exit rather than spin an empty loop looking busy.
    console.warn('[collector] no collection module configured — nothing to do. Exiting.')
    console.log(health.heartbeatLine())
    return
  }

  console.log('[collector] entering collect → push loop. Ctrl-C to stop.')
  const stop = startLoop({ modules, channel, health, log: (m) => console.log(m) }, config.pollIntervalMs)

  const shutdown = () => {
    console.log('\n[collector] stopping.')
    stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
