import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('./dsh-runtime-server.mjs', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./dsh-runtime-settings.yaml', import.meta.url), 'utf8')

describe('DSH Moonshot 生产源配置', () => {
  it('kimi-k3 只映射到 moonshotai-cn，不改变 SCNet 默认链', () => {
    expect(server).toContain("patched = patched.replace(providerPattern, '$1moonshotai-cn')")
    expect(server).toContain("modelOverride === 'kimi-k3'")
    expect(settings).toContain('provider: scnet')
    expect(settings).toContain('model: DeepSeek-V4.1-Flash-1017')
    expect(settings).toContain('  moonshotai-cn:')
    expect(settings).toContain('- id: kimi-k3')
    expect(settings).toContain('baseURL: https://api.moonshot.cn/v1')
  })
  it('Kimi 凭证只从环境变量注入，禁止把密钥写入源文件', () => {
    expect(server).toContain("'KIMI_API_KEY'")
    expect(settings).toContain('apiKeyEnv: KIMI_API_KEY')
    expect(settings).not.toMatch(/sk-[A-Za-z0-9]/)
  })
})
