/**
 * 宪法公证节点（M3 三方签名第三方）——独立于中枢主流程的签名器。
 * 密钥只从 env CONSTITUTION_NOTARY_KEY 读取（不进代码/日志/库明文）；
 * 未配置时使用固定开发键（生产必须配置，部署文档已注记）。
 * 签名对象：修正案 payload（id|factoryId|from|to|proposer），HMAC-SHA256 hex。
 */
import { createHmac } from "node:crypto";

const KEY = process.env.CONSTITUTION_NOTARY_KEY || "lingshu-constitution-notary-dev-v1";

export function notarySign(payload: string): string {
  return createHmac("sha256", KEY).update(payload).digest("hex");
}

export function notaryVerify(payload: string, sig: string): boolean {
  return notarySign(payload) === sig;
}

export function amendmentPayload(id: number, factoryId: number, from: string, to: string, proposer: string): string {
  return `${id}|${factoryId}|${from}|${to}|${proposer}`;
}
