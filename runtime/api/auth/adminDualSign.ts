import { TRPCError } from "@trpc/server";
import { normalizeCiText } from "@contracts/authLock";
import { wbThreadUserId } from "./identity";
import { requireCabinAction, type CabinAction } from "./cabinGate";

/** C 级双签单源：两席都必须有写权；按命名空间分带 id+CI 归一用户名判同人，审计 id 同带返回。 */
export async function requireDualSign(operatorToken: string, reviewToken: string, action: CabinAction) {
  const [op, rv] = await Promise.all([
    requireCabinAction(operatorToken, action),
    requireCabinAction(reviewToken, action),
  ]);
  if (!Number.isSafeInteger(op.id) || !Number.isSafeInteger(rv.id) || op.id <= 0 || rv.id <= 0) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "C 级双签：席位身份无效——请先修正账号映射" });
  }
  const operatorId = wbThreadUserId(op);
  const reviewerId = wbThreadUserId(rv);
  const samePerson = operatorId === reviewerId || normalizeCiText(op.username) === normalizeCiText(rv.username);
  if (samePerson) {
    throw new TRPCError({ code: "FORBIDDEN", message: "C 级双签：复核人不能与操作人同一人（复核岗永不由执行岗兼任）" });
  }
  return { operator: op.username, reviewer: rv.username, operatorId, reviewerId };
}
