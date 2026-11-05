/**
 * enterpriseVerify —— 企业注册接入国家企业信用信息公示系统核验（迭代 90）。
 *
 * 1) isValidCreditCode：GB 32100-2015 统一社会信用代码本地校验（18 位 + 校验位）。
 * 2) verifyEnterprise：调用天眼查开放平台工商基本信息接口做权威比对。
 *    - token 只从 process.env.TYC_TOKEN 读取，绝不写代码/日志；
 *    - 任何网络/接口异常一律降级 pending_manual，不向外抛。
 */

// ─── GB 32100-2015 统一社会信用代码校验 ────────────────────────────────────

// 字符集：0-9 A-Z，排除 I、O、S、Z、V
const CODE_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** 统一社会信用代码格式 + 校验位校验（GB 32100-2015）。 */
export function isValidCreditCode(code: string): boolean {
  if (!code) return false;
  const c = code.trim().toUpperCase();
  if (c.length !== 18) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const v = CODE_CHARS.indexOf(c[i]);
    if (v < 0) return false;
    sum += v * WEIGHTS[i];
  }
  const check = (31 - (sum % 31)) % 31;
  return CODE_CHARS[check] === c[17];
}

// ─── 权威核验 ───────────────────────────────────────────────────────────────

export type VerifyStatus = "verified" | "mismatch" | "not_found" | "pending_manual";

export interface VerifyResult {
  status: VerifyStatus;
  payload?: Record<string, unknown>;
}

/** 名称归一：去全部空白 + 全角括号转半角。 */
function normalizeName(name: string): string {
  return name.replace(/[\s　]+/g, "").replace(/（/g, "(").replace(/）/g, ")");
}

interface TianyanchaResp {
  code?: number;
  message?: string;
  result?: {
    creditCode?: string;
    name?: string;
    legalPersonName?: string;
    regStatus?: string;
    regCapital?: string | number;
    estiblishTime?: string | number;
  } | null;
}

/**
 * 按信用代码查询权威工商数据并与入参企业名/信用代码比对。
 * 永不 throw：无 token、超时、HTTP/接口异常 → pending_manual。
 */
export async function verifyEnterprise(
  enterpriseName: string,
  creditCode: string,
): Promise<VerifyResult> {
  const token = process.env.TYC_TOKEN;
  if (!token) {
    return { status: "pending_manual", payload: { reason: "provider_not_configured" } };
  }
  try {
    const url = `http://open.api.tianyancha.com/services/open/ic/baseinfo/2.0?keyword=${encodeURIComponent(
      creditCode,
    )}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: token },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      return {
        status: "pending_manual",
        payload: { reason: "provider_http_error", httpStatus: resp.status },
      };
    }
    const data = (await resp.json()) as TianyanchaResp;
    const result = data?.result;
    if (data?.code === 0 && result && result.creditCode) {
      const codeHit = result.creditCode.trim().toUpperCase() === creditCode.trim().toUpperCase();
      const nameHit =
        typeof result.name === "string" &&
        normalizeName(result.name) === normalizeName(enterpriseName);
      if (codeHit && nameHit) {
        return {
          status: "verified",
          payload: {
            legalPersonName: result.legalPersonName ?? null,
            regStatus: result.regStatus ?? null,
            regCapital: result.regCapital ?? null,
            estiblishTime: result.estiblishTime ?? null,
            provider: "tianyancha",
            queriedAt: new Date().toISOString(),
          },
        };
      }
      return {
        status: "mismatch",
        payload: {
          provider: "tianyancha",
          queriedAt: new Date().toISOString(),
          codeHit,
          nameHit,
        },
      };
    }
    // code===300001 等为查无结果；其余非 0 code 视为接口异常
    if (data?.code === 300001 || (data?.code === 0 && !result)) {
      return {
        status: "not_found",
        payload: { provider: "tianyancha", queriedAt: new Date().toISOString() },
      };
    }
    if (data?.code !== 0 && typeof data?.code === "number") {
      return {
        status: "pending_manual",
        payload: { reason: "provider_biz_error", providerCode: data.code },
      };
    }
    return {
      status: "not_found",
      payload: { provider: "tianyancha", queriedAt: new Date().toISOString() },
    };
  } catch (err) {
    return {
      status: "pending_manual",
      payload: {
        reason: "provider_error",
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      },
    };
  }
}
