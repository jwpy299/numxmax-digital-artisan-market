#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const sbom = JSON.parse(readFileSync(new URL('../../SBOM.json', import.meta.url), 'utf8'))
const errors = []
if (sbom.bomFormat !== 'CycloneDX') errors.push('bomFormat')
if (sbom.specVersion !== '1.5') errors.push('specVersion')
if (!Array.isArray(sbom.components) || sbom.components.length === 0) errors.push('components')
if (!sbom.metadata?.timestamp) errors.push('metadata.timestamp')
for (const [index, component] of (sbom.components ?? []).entries()) {
  if (!component.name || !component.version) errors.push(`components[${index}].name/version`)
  if (!Array.isArray(component.licenses) || component.licenses.length === 0) errors.push(`components[${index}].licenses`)
}
if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, bomFormat: sbom.bomFormat, specVersion: sbom.specVersion, components: sbom.components.length, metadataTimestamp: sbom.metadata.timestamp }, null, 2))
