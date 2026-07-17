/**
 * Security response headers (RFP §5.x).
 *
 * Applied in middleware, so they cover every response — including error pages and the 404,
 * which is exactly where a per-route approach forgets them.
 */

/**
 * Content-Security-Policy.
 *
 * `'unsafe-inline'` on script-src is required by Next's App Router: it inlines the RSC
 * payload and the bootstrap script into the HTML. The correct fix is a per-request nonce,
 * which Next supports — but it forces every page onto dynamic rendering, and the honest
 * position is that we have not yet measured that cost against this estate's traffic.
 * Recorded as a known gap rather than quietly omitted (see ADR-0023).
 *
 * Everything else is locked to `'self'`. The OAT loads no third-party scripts, fonts, or
 * images by design — a register of laboratory assets has no business talking to a CDN, and
 * `default-src 'self'` means a future dependency that tries cannot.
 */
const CSP = [
  "default-src 'self'",
  // See above: Next's inline bootstrap. `'unsafe-eval'` is deliberately NOT permitted.
  "script-src 'self' 'unsafe-inline'",
  // Tailwind emits a stylesheet, but Next inlines critical CSS.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // No XHR/WebSocket anywhere but us. The app has no third-party integrations in the browser
  // — connectors are server-side, and SAP is never contacted from a page.
  "connect-src 'self'",
  // Nothing is embedded, and nothing may embed us.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // The only forms post to us. Blocks a classic exfiltration route.
  "form-action 'self'",
].join('; ')

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,

  // Clickjacking. Redundant with frame-ancestors for modern browsers, kept for older ones.
  'X-Frame-Options': 'DENY',

  // Stops a browser second-guessing a Content-Type and executing something as script.
  'X-Content-Type-Options': 'nosniff',

  // Send the full URL only to ourselves. An OAT URL can carry an asset id, and that should
  // not travel to a third party in a Referer header.
  'Referrer-Policy': 'same-origin',

  // We use none of these. Denying them means a future dependency cannot quietly start.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',

  // Cross-origin isolation: no other origin may read or embed our responses.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',

  // Two years, subdomains included. Set unconditionally rather than only when the request
  // arrives over HTTPS: behind a TLS-terminating proxy (the Malaysia-region load balancer,
  // A5) the app sees plain HTTP, so a conditional check would silently never fire — the same
  // class of proxy blindness that produced ADR-0012 and the redirect bug.
  //
  // Harmless over plain HTTP: browsers ignore HSTS on non-secure responses.
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
}

/** Apply every security header to a response. */
export function withSecurityHeaders<T extends { headers: Headers }>(response: T): T {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}
