/** 独立信任锚唯一解析入口：多键轮换、trim、去重和坏配置在所有调用面保持一致。 */
export function readTrustedAgentPluginPublicKeys(): string[] {
  const many = process.env.AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS?.trim() ?? ''
  if (many) {
    try {
      const parsed = JSON.parse(many) as unknown
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((key) => typeof key !== 'string' || key.trim().length === 0)) throw new Error('invalid')
      return [...new Set(parsed.map((key) => key.trim()))]
    } catch {
      throw new Error('agent_plugin_trusted_keys_invalid')
    }
  }
  const single = process.env.AGENT_PLUGIN_TRUSTED_PUBLIC_KEY?.trim() ?? ''
  if (!single) throw new Error('agent_plugin_trusted_key_missing')
  return [single]
}
