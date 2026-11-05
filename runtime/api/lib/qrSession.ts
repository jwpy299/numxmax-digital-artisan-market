/**
 * qrSession —— 扫码登录会话号格式单源（ql_+24hex——APP assetScan/qrImage/qrLogin 三面同引；
 *  独立小件面：qrImage 只引本件=不拖 qrLogin 模块图（db/schema/crypto 面），门禁 wb#73 钉）。
 */
import { randomBytes } from "node:crypto";

export const QR_SESSION_RE = /^ql_[0-9a-f]{24}$/;

/** 管理台/工作台共用的会话号生成面：ql_ + 12 字节随机数（24 hex）。 */
export function newQrSession(): string {
  return `ql_${randomBytes(12).toString("hex")}`;
}
