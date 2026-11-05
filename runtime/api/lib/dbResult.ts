/** mysql2/drizzle 写结果统一读取：tuple/裸结果、number/string 数字兼容；形状异常绝不静默折算成 0 行。 */
function writeResultRow(result: unknown): Record<string, unknown> {
  const first = Array.isArray(result) ? result[0] : result;
  if (first === null || typeof first !== "object" || Array.isArray(first)) throw new Error("写结果形状无效");
  return first as Record<string, unknown>;
}

function safeCount(value: unknown, field: "affectedRows" | "insertId"): number {
  if (value === null || value === undefined || value === "" || typeof value === "boolean" || Array.isArray(value)) throw new Error(`写结果缺少有效 ${field}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || (field === "insertId" && n === 0)) throw new Error(`写结果缺少有效 ${field}`);
  return n;
}

export function affectedRowsOf(result: unknown): number {
  return safeCount(writeResultRow(result).affectedRows, "affectedRows");
}

export function insertIdOf(result: unknown): number {
  return safeCount(writeResultRow(result).insertId, "insertId");
}
