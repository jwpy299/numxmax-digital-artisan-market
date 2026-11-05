import { hqFactoryIds } from "../auth/adminGate";

/** 本厂组织运行时 ID：与鉴权共用 HQ_FACTORY_IDS 解析、剔除告警和零有效报错；不保留第三套解析或源码厂号回落。 */
export function hqFactoryId(): number {
  const first = hqFactoryIds()[0];
  if (first === undefined) throw new Error("HQ_FACTORY_IDS 未配置或配置无效");
  return first;
}
