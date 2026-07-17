#!/usr/bin/env node
/**
 * Licence gate. Fails the build on any non-permissive licence in the transitive tree.
 *
 * ABeam hands this source to Lablink with zero copyleft obligation (ADR-0003), and a single
 * GPL/AGPL/LGPL/SSPL package — however deep, pulled in by however permissive a parent —
 * would put that at risk. Reviewing hundreds of transitive packages by eye at handover is
 * not credible, so the check runs on every PR instead.
 *
 * This is not hypothetical: the gate caught `@img/sharp-libvips` (LGPL-3.0-or-later)
 * arriving as an optional dependency of Next. See ADR-0007.
 *
 * Uses `pnpm licenses`, which resolves the real pnpm workspace tree. A generic
 * node_modules walker reports zero packages under pnpm's layout — a gate that passes while
 * inspecting nothing is worse than no gate at all, so the package count is asserted below.
 *
 * The policy lives here, in version control, rather than in a CI flag, so that changing it
 * is a reviewable diff.
 */
import { execFileSync } from 'node:child_process'

/** SPDX identifiers we accept. Permissive only — see ADR-0003. */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  // Attribution-only content licences. Not copyleft: they impose no obligation on our
  // source. caniuse-lite (browser support data, via Next) ships under CC-BY-4.0.
  'CC-BY-3.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
])

/**
 * Licences that would impose obligations on delivered source. Named explicitly so the
 * failure says *why*, rather than a bare "unrecognised".
 *
 * LGPL is included even though the brief names only GPL/AGPL/SSPL: it is still copyleft,
 * and the brief's rule is that the build fails on ANY copyleft transitive dependency.
 */
const COPYLEFT_MARKERS = [
  'AGPL',
  'LGPL',
  'GPL',
  'SSPL',
  'CDDL',
  'EPL',
  'MPL',
  'CPAL',
  'OSL',
  'EUPL',
  'CC-BY-SA',
  'CC-BY-NC',
]

/**
 * Packages exempted from the gate, name → reason. Each entry requires an ADR explaining
 * why no permissive alternative exists and why the obligation cannot reach delivered
 * source. Empty, and intended to stay that way.
 */
const EXCEPTIONS = new Map()

/**
 * A tree this small means the scan resolved nothing. Guards against a silent false pass if
 * pnpm changes its output shape or the command runs before install.
 */
const MIN_EXPECTED_PACKAGES = 20

/**
 * Decide whether an SPDX expression is acceptable.
 *
 * `MIT OR GPL-3.0` is fine — we may elect MIT. `MIT AND GPL-3.0` is not: both bind us.
 * Matching the raw string would get both of those wrong, so parse the expression.
 */
function isAllowed(expression) {
  const cleaned = expression.replace(/[()]/g, ' ').trim()

  if (/\s+OR\s+/i.test(cleaned)) {
    return cleaned.split(/\s+OR\s+/i).some((part) => isAllowed(part))
  }
  if (/\s+AND\s+/i.test(cleaned)) {
    return cleaned.split(/\s+AND\s+/i).every((part) => isAllowed(part))
  }

  return ALLOWED.has(cleaned.replace(/\+$/, '').trim())
}

function classify(expression) {
  const upper = expression.toUpperCase()
  const marker = COPYLEFT_MARKERS.find((m) => upper.includes(m))
  return marker ? `copyleft (${marker})` : 'not on the permissive allowlist'
}

function main() {
  let raw
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    console.error('Licence scan failed to run:', error.message)
    process.exit(2)
  }

  // pnpm groups by licence: { "MIT": [{ name, versions, ... }], ... }
  const byLicence = JSON.parse(raw)
  const violations = []
  let total = 0

  for (const [licence, packages] of Object.entries(byLicence)) {
    for (const pkg of packages) {
      total++
      if (EXCEPTIONS.has(pkg.name)) continue

      // An absent or unreadable licence fails deliberately. "We could not tell" is not the
      // same as "it is fine", and at handover that difference is the whole point.
      if (!licence || licence === 'UNKNOWN' || licence === 'Unknown') {
        violations.push({
          name: pkg.name,
          versions: pkg.versions,
          licence: '(none declared)',
          reason: 'no licence declared',
        })
        continue
      }

      if (!isAllowed(licence)) {
        violations.push({ name: pkg.name, versions: pkg.versions, licence, reason: classify(licence) })
      }
    }
  }

  if (total < MIN_EXPECTED_PACKAGES) {
    console.error(
      `✗ Licence gate ABORTED — scanned only ${total} packages, expected at least ${MIN_EXPECTED_PACKAGES}.\n` +
        '  The scan is not seeing the dependency tree. Run `pnpm install` first.\n' +
        '  Failing rather than reporting a pass over an empty tree.',
    )
    process.exit(2)
  }

  if (violations.length > 0) {
    console.error(`\n✗ Licence gate FAILED — ${violations.length} of ${total} packages are not permitted:\n`)
    for (const v of violations) {
      console.error(
        `  ${v.name}@${(v.versions ?? []).join(', ')}\n      licence: ${v.licence}\n      reason:  ${v.reason}`,
      )
    }
    console.error('\nPermissive licences only (MIT / Apache-2.0 / BSD / ISC).')
    console.error('See docs/decisions/0003-permissive-licences-only-enforced-in-ci.md.')
    console.error('If a package is genuinely unavoidable, write an ADR and add it to EXCEPTIONS in this script.\n')
    process.exit(1)
  }

  console.log(`✓ Licence gate passed — ${total} production packages, all permissively licensed.`)
  console.log(`  Licences present: ${Object.keys(byLicence).sort().join(', ')}`)
}

main()
