/** dupEntry 归中立足（战区④批 A-lite：本地副本退役——re-export canonical 单源[../queries/dupEntry]，4 处消费方零改）。
 *  ⚠️ 行为口径变化如实登记：isDupEntry 消息匹配从 includes 归中到 canonical 的 cause 链判别面（门禁 OCR 指正的 5 跳面——canonical 为准） */
export { isDupEntry, hasCauseChainMatch, isDupColumn, type CauseChainTarget } from "../queries/dupEntry";
