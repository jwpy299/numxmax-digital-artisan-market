import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const base='dba7246fa397b9556c05a798fa1c77cd21bf8a9d'
const forbidden=['api/lib/agentPluginManifest.ts','api/routers/agentPlugins.ts','api/routers/agentPluginPayments.ts','src/components/agent/AgentPluginWorkbench.tsx','src/pages/Packages.tsx','db/sync-agent-plugins.mts','db/sync-agent-plugin-payments.mts','scripts/agent_plugin_zip_reader.py','scripts/agent_plugin_zip_writer.py']
const changed=execFileSync('git',['diff','--name-only',base,'--',...forbidden],{encoding:'utf8'}).trim()
const adapters=readFileSync('api/runtimeContainer/adapters.ts','utf8')
const registry=readFileSync('api/runtimeContainer/registry.ts','utf8')
const protocol=readFileSync('contracts/agentRuntimePlugin.ts','utf8')
const checks={arp:protocol.includes("protocol: 'arp-v1'")&&protocol.includes('agentNotModel'),dshAgent:adapters.includes('callDsh')&&adapters.includes('agentStationKey'),noChatCompletion:!adapters.includes('chat/completions'),profiles:registry.includes('kimi-k3')&&registry.includes('glm-5.2')&&registry.includes('qwen3.5:cloud'),workbuddyBridge:adapters.includes('readWorkbuddyAgentConfig'),pluginSystemUnchanged:!changed}
const result={schema:'numx.runtime-container.verifier.v4.static',ok:Object.values(checks).every(Boolean),checks,existingPluginSystemChanged:changed?changed.split('\n'):[]}
console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1
