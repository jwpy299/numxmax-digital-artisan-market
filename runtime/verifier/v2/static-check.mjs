import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const base='dba7246fa397b9556c05a798fa1c77cd21bf8a9d'
const forbidden=['api/lib/agentPluginManifest.ts','api/lib/agentPluginTestPackage.ts','api/routers/agentPlugins.ts','api/routers/agentPluginPayments.ts','src/components/agent/AgentPluginWorkbench.tsx','src/pages/Packages.tsx','db/sync-agent-plugins.mts','db/sync-agent-plugin-payments.mts','scripts/agent_plugin_zip_reader.py','scripts/agent_plugin_zip_writer.py']
const changed=execFileSync('git',['diff','--name-only',base,'--',...forbidden],{encoding:'utf8'}).trim()
const required=['contracts/agentRuntimeContainer.ts','api/runtimeContainer/registry.ts','api/runtimeContainer/planner.ts','api/runtimeContainer/service.ts','api/runtimeContainer/delegation.ts','api/routers/agentRuntimeContainer.ts','db/sync-agent-runtime-container.mts','api/runtimeContainer/service.test.ts','api/routers/agentRuntimeContainer.mysql.integration.test.ts']
const missing=required.filter((file)=>!existsSync(file))
const migration=existsSync('db/sync-agent-runtime-container.mts')?readFileSync('db/sync-agent-runtime-container.mts','utf8'):''
const service=existsSync('api/runtimeContainer/service.ts')?readFileSync('api/runtimeContainer/service.ts','utf8'):''
const employment=readFileSync('api/routers/agentEmployment.ts','utf8')
const checks={
  candidateTable:migration.includes('st_agent_runtime_candidates'),
  canonicalOutbox:migration.includes('st_agent_runtime_outbox')&&migration.includes('dedupe_key'),
  scopedDelegation:migration.includes('st_agent_runtime_delegations')&&employment.includes("scope='submitTask'"),
  existingCompetition:service.includes('publishJob')&&service.includes('applyJob')&&service.includes('reviewApplication'),
  existingWagePath:service.includes('reviewTask')&&!service.includes('INSERT INTO st_agent_wage_ledger'),
  eventDriven:service.includes('pumpRuntimeEvents'),
  strictScnetModel:existsSync('api/runtimeContainer/planner.ts')&&readFileSync('api/runtimeContainer/planner.ts','utf8').includes('DeepSeek-V4.1-Flash-1017'),
}
const result={schema:'numx.runtime-container.verifier.v2.static',ok:!changed&&missing.length===0&&Object.values(checks).every(Boolean),base,existingPluginSystemChanged:changed?changed.split('\n'):[],missing,checks}
console.log(JSON.stringify(result,null,2))
if(!result.ok)process.exitCode=1
