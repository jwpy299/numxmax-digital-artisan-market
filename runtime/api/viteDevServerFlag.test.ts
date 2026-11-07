import { afterEach, describe, expect, it, vi } from 'vitest'

describe('Vite dev server 标记', () => {
  afterEach(() => { delete process.env.NEBULA_VITE_DEV_SERVER; vi.resetModules() })
  it('command=serve 设置 dev 标记，command=build 不设置', async () => {
    const config = (await import('../vite.config')).default
    await config({ command: 'serve', mode: 'development' })
    expect(process.env.NEBULA_VITE_DEV_SERVER).toBe('1')
    delete process.env.NEBULA_VITE_DEV_SERVER
    await config({ command: 'build', mode: 'production' })
    expect(process.env.NEBULA_VITE_DEV_SERVER).toBeUndefined()
  })
})
