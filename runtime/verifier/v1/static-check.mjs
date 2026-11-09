import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const base = 'dba7246fa397b9556c05a798fa1c77cd21bf8a9d'
const forbidden = [
  'api/lib/agentPluginManifest.ts', 'api/lib/agentPluginTestPackage.ts',
  'api/routers/agentPlugins.ts', 'api/routers/agentPluginPayments.ts',
  'src/components/agent/AgentPluginWorkbench.tsx', 'src/pages/Packages.tsx',
  'db/sync-agent-plugins.mts', 'db/sync-agent-plugin-payments.mts',
  'scripts/agent_plugin_zip_reader.py', 'scripts/agent_plugin_zip_writer.py',
]
const changed = execFileSync('git', ['diff', '--name-only', base, '--', ...forbidden], { encoding: 'utf8' }).trim()
const required = [
  'contracts/agentRuntimeContainer.ts',
  'api/runtimeContainer/registry.ts',
  'api/runtimeContainer/planner.ts',
  'api/runtimeContainer/service.ts',
  'api/routers/agentRuntimeContainer.ts',
  'db/sync-agent-runtime-container.mts',
  'api/runtimeContainer/service.test.ts',
  'api/routers/agentRuntimeContainer.mysql.integration.test.ts',
]
const missing = required.filter((file) => !existsSync(`${root}/${file}`))
const result = {
  schema: 'numx.runtime-container.verifier.v1.static',
  ok: !changed && missing.length === 0,
  base,
  existingPluginSystemChanged: changed ? changed.split('\n') : [],
  missing,
  checks: {
    canonicalTables: existsSync(`${root}/db/sync-agent-runtime-container.mts`),
    executedNotDone: existsSync(`${root}/contracts/agentRuntimeContainer.ts`) && readFileSync(`${root}/contracts/agentRuntimeContainer.ts`, 'utf8').includes('awaiting_review'),
    strictScnetModel: existsSync(`${root}/api/runtimeContainer/planner.ts`) && readFileSync(`${root}/api/runtimeContainer/planner.ts`, 'utf8').includes('DeepSeek-V4.1-Flash-1017'),
  },
}
result.ok = result.ok && Object.values(result.checks).every(Boolean)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
