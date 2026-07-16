#!/usr/bin/env node
/**
 * Generate a CycloneDX-style SBOM of production dependencies (RFP §8).
 *
 * Derived from `pnpm licenses`, so the SBOM and the licence gate report the same tree —
 * two sources of truth that could disagree would make both untrustworthy.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

const byLicence = JSON.parse(raw)
const components = []

for (const [licence, packages] of Object.entries(byLicence)) {
  for (const pkg of packages) {
    for (const version of pkg.versions ?? []) {
      components.push({
        type: 'library',
        name: pkg.name,
        version,
        purl: `pkg:npm/${pkg.name.replace('@', '%40')}@${version}`,
        licenses: [{ license: { id: licence } }],
        ...(pkg.homepage ? { externalReferences: [{ type: 'website', url: pkg.homepage }] } : {}),
      })
    }
  }
}

components.sort((a, b) => a.name.localeCompare(b.name))

// `timestamp` is intentionally omitted: a wall-clock field would make every regenerated
// SBOM a diff, which trains reviewers to ignore SBOM changes — the opposite of the point.
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: { type: 'application', name: 'lablink-oat', version: '0.1.0' },
    licenses: [{ license: { id: 'Apache-2.0' } }],
  },
  components,
}

const out = 'sbom.json'
writeFileSync(out, JSON.stringify(sbom, null, 2) + '\n')
console.log(`✓ SBOM written to ${out} — ${components.length} components.`)
