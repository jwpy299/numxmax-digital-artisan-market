/**
 * WbMechaEntrance —— M13.5「数字人具身」入场层（s2 工作台薄封装）。
 *
 * 核心实现已抽取为共享组件 @/components/digitalhuman/MechaEntrance（选人/声线/打字机/
 * 降级/onend 后唤起 buddy 等逻辑原样保留）；本文件仅注入工作台端配置：
 * - 会话键 wb_mecha_entered；唤起事件 'wb:open-buddy'（VoiceBuddy 监听）；
 * - 主按钮「进入工作台 · 开启语音」，次按钮「先进去看看」。
 * 纯逻辑函数（pickMechaEntrance / buildOpenBuddyDetail 等）自此 re-export，保持既有引用不破。
 */
import MechaEntrance, {
  buildOpenBuddyDetail,
  pickMechaEntrance,
  resolveMechaEntranceChoice,
} from '@/components/digitalhuman/MechaEntrance'
import type { MechaEntranceChoice, MechaPersona } from '@/components/digitalhuman/MechaEntrance'

export const MECHA_SESSION_KEY = 'wb_mecha_entered'

export { buildOpenBuddyDetail, pickMechaEntrance, resolveMechaEntranceChoice }
export type { MechaEntranceChoice, MechaPersona }

export default function WbMechaEntrance() {
  return (
    <MechaEntrance
      storageKey={MECHA_SESSION_KEY}
      openEventName="wb:open-buddy"
      enterLabel="进入工作台 · 开启语音"
    />
  )
}
