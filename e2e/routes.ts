import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every page and API route, DISCOVERED from the filesystem rather than listed by hand.
 *
 * This is the whole point. A hand-maintained list goes stale the moment someone adds a page,
 * and the page that gets forgotten is exactly the one that ships without a guard. Two scope
 * leaks (ADR-0012, ADR-0017) were both invisible in review and obvious the moment somebody
 * signed in and looked; neither was in a route we would have thought to list.
 *
 * `EXPECTATIONS` below must name every discovered route. A new route with no entry FAILS the
 * suite — you cannot add a page without stating, in one line, who may see it.
 */

const APP_DIR = join(process.cwd(), 'app', 'src', 'app')

function walk(dir: string, filename: string): string[] {
  const out: string[] = []

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, filename))
    } else if (entry === filename) {
      out.push(dir)
    }
  }
  return out
}

/** `app/src/app/assets/[id]` → `/assets/[id]` */
function toRoute(dir: string): string {
  const relative = dir.slice(APP_DIR.length).replace(/\\/g, '/')
  // Route groups `(name)` are organisational and contribute nothing to the URL.
  const cleaned = relative.replace(/\/\([^/]+\)/g, '')
  return cleaned === '' ? '/' : cleaned
}

/** Every page route in the app. */
export function discoverPages(): string[] {
  return walk(APP_DIR, 'page.tsx').map(toRoute).sort()
}

/** Every API route in the app. */
export function discoverApiRoutes(): string[] {
  return walk(APP_DIR, 'route.ts').map(toRoute).sort()
}

/** How a route should behave for an anonymous caller. */
export type AnonymousExpectation =
  /** Reachable by anyone. Must leak nothing beyond its purpose. */
  | 'public'
  /** A human is redirected to sign in. */
  | 'redirect-to-signin'
  /** An API caller is refused. */
  | 'unauthorised'

export interface RouteExpectation {
  anonymous: AnonymousExpectation
  /** Why this route is public, if it is. Forces the question to be answered in writing. */
  why?: string
}

/**
 * What every route must do for an anonymous caller.
 *
 * Adding a route without adding an entry here fails the suite. That friction is deliberate:
 * "who may see this?" is not a question to answer later.
 */
export const EXPECTATIONS: Record<string, RouteExpectation> = {
  // Pages
  '/': { anonymous: 'redirect-to-signin' },
  '/alerts': { anonymous: 'redirect-to-signin' },
  '/assets': { anonymous: 'redirect-to-signin' },
  '/assets/[id]': { anonymous: 'redirect-to-signin' },
  '/heatmap': { anonymous: 'redirect-to-signin' },
  '/reconciliation': { anonymous: 'redirect-to-signin' },
  '/settings/idle-policy': { anonymous: 'redirect-to-signin' },
  '/signin': { anonymous: 'public', why: 'The sign-in page. By definition there is no session yet.' },

  // API
  '/api/admin/rollup': { anonymous: 'unauthorised' },
  '/api/admin/sweep': { anonymous: 'unauthorised' },
  '/api/alerts': { anonymous: 'unauthorised' },
  '/api/alerts/[id]': { anonymous: 'unauthorised' },
  '/api/assets': { anonymous: 'unauthorised' },
  '/api/assets/[tag]/utilisation': { anonymous: 'unauthorised' },
  '/api/audit/export': { anonymous: 'unauthorised' },
  '/api/auth/[...nextauth]': {
    anonymous: 'public',
    why: 'The sign-in flow itself, plus CSRF and session endpoints. Auth.js owns its own protection.',
  },
  '/api/connectors/soti/poll': { anonymous: 'unauthorised' },
  '/api/health': {
    anonymous: 'public',
    why: 'A liveness probe for compose and the load balancer. Leaks nothing beyond "the database answers".',
  },
  '/api/idle-config': { anonymous: 'unauthorised' },
  '/api/reconciliation': { anonymous: 'unauthorised' },
  '/api/reconciliation/[id]': { anonymous: 'unauthorised' },
  '/api/sap/sync': { anonymous: 'unauthorised' },
  '/api/signals/scan': { anonymous: 'unauthorised' },
}

/** A concrete URL to probe, since a dynamic segment cannot be fetched as `[id]`. */
export function probeUrl(route: string, ids: { assetId: string; tag: string }): string {
  return route.replace('[id]', ids.assetId).replace('[tag]', ids.tag).replace('[...nextauth]', 'session')
}
