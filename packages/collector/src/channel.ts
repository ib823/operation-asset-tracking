import type { UnresolvedSignal } from '@oat/connectors'
import { z } from 'zod'
import type { ChannelConfig } from './config'

/**
 * The outbound channel (ADR-0021).
 *
 * The collector's ONLY connection to the outside world: an HTTPS POST of normalised signals to
 * cloud OAT. It is outbound-only — this client opens no listener, and it makes exactly one kind
 * of request (POST /api/collector/ingest). It carries the per-collector bearer and id, and it
 * never logs the token.
 *
 * `fetchImpl` is injected so tests exercise the real request-building and error handling against
 * a fake, rather than a second parallel implementation.
 */

export interface PushResult {
  collectorId: string
  accepted: number
  duplicates: number
  /** External refs OAT could not match to an asset. Reported, never created (ADR-0009). */
  unmatched: string[]
  assetsUpdated: string[]
}

const PushResponse = z.object({
  collectorId: z.string(),
  accepted: z.number(),
  duplicates: z.number(),
  unmatched: z.array(z.string()),
  assetsUpdated: z.array(z.string()),
})

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

export class OatChannel {
  private readonly ingestUrl: string

  constructor(
    private readonly config: ChannelConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    // Resolve once, against the configured base. A trailing path on OAT_URL is respected.
    this.ingestUrl = new URL('/api/collector/ingest', config.oatUrl).toString()
  }

  /**
   * Push a batch of signals to OAT. Throws {@link ChannelError} on any non-2xx or transport
   * failure, so the caller can record the cycle as failed and retry next tick — at-least-once
   * delivery is safe because OAT dedupes on `(source, dedupeKey)`.
   */
  async push(signals: readonly UnresolvedSignal[]): Promise<PushResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(this.ingestUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'X-Collector-Id': this.config.collectorId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ signals }),
        signal: controller.signal,
      })

      if (!response.ok) {
        // Do NOT include the response body blindly — keep the failure to status only, so a
        // verbose server error can never carry a secret into the collector's logs.
        throw new ChannelError(`OAT ingest returned ${response.status} ${response.statusText}`, response.status)
      }

      return PushResponse.parse(await response.json())
    } catch (error) {
      if (error instanceof ChannelError) throw error
      throw new ChannelError(error instanceof Error ? error.message : 'push failed')
    } finally {
      clearTimeout(timer)
    }
  }
}
