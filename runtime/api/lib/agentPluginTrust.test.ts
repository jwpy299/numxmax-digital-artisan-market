import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTrustedAgentPluginPublicKeys } from './agentPluginTrust'

afterEach(() => { vi.unstubAllEnvs() })
describe('Agent 插件独立信任键解析', () => {
  it('多键 trim、去重并保留轮换顺序', () => {
    vi.stubEnv('AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS', JSON.stringify([' old ', ' new ', 'old']))
    vi.stubEnv('AGENT_PLUGIN_TRUSTED_PUBLIC_KEY', 'ignored-single')
    expect(readTrustedAgentPluginPublicKeys()).toEqual(['old', 'new'])
  })
  it('坏 JSON、空集合与未配置全部稳定 fail-closed', () => {
    vi.stubEnv('AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS', '{bad')
    expect(() => readTrustedAgentPluginPublicKeys()).toThrow('agent_plugin_trusted_keys_invalid')
    vi.stubEnv('AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS', '[]')
    expect(() => readTrustedAgentPluginPublicKeys()).toThrow('agent_plugin_trusted_keys_invalid')
    vi.stubEnv('AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS', '')
    vi.stubEnv('AGENT_PLUGIN_TRUSTED_PUBLIC_KEY', '')
    expect(() => readTrustedAgentPluginPublicKeys()).toThrow('agent_plugin_trusted_key_missing')
  })
})
