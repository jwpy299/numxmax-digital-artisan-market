/**
 * 角色专属 Agent 展示助手：推荐池 Agent 中文名 → 本地头像资源映射，
 * 未命中时回退为「首字圆块」。
 */

const AGENT_AVATAR_MAP: [string, string][] = [
  ['振衡', '/avatar-zhenheng.png'],
  ['听涛', '/avatar-tingtao.png'],
  ['炽眸', '/avatar-chimou.png'],
  ['衡准', '/avatar-hengzhun.png'],
  ['策炉', '/avatar-celu.png'],
  ['巡线', '/avatar-xunxian.png'],
]

export function agentAvatarSrc(agentName: string): string | null {
  for (const [key, src] of AGENT_AVATAR_MAP) {
    if (agentName.includes(key)) return src
  }
  return null
}

/** 首字（去掉括号与空白） */
export function agentInitial(agentName: string): string {
  const c = agentName.trim().charAt(0)
  return c || 'AI'
}
