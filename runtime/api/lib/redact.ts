/**
 * redact —— 连接目标脱敏链共享单点（portal#40 R10 票①：pool error 等原生驱动报文带 host:port/主机名，
 *  脱敏链必须唯一出处——healthProbe（探测面）与 connection（池 error 面）同引本件，不双写不循环）。
 * 顺序不可换：先归一化控制字符再脱敏、最后截断（先截断会把连接目标拦腰切断逃出 regex——R26 已修此序；
 *  先归一化防控制字符拆散 token 逃出锚定 regex——R12 票①；两处顺序皆有安全语义，勿调）。
 * 主机名抹除面写实（R26 票③ 同构）：错误码锚定支＋引号形态支＋点分支＋裸 host:port 支——
 *  单标签裸主机名仅在锚定形态抹除；无锚点英文文本里的裸词无法与正常英文词区分，强行抹=错误摘要变 *** 汤——此面如实登记为【不抹】，宁欠不过。
 * 代价是 table.column 点分标识被误抹——只进 120 字错误摘要，脱敏方向宁过不欠（triage 线索让位泄密面）。
 */
export function redactConnTarget(raw: string): string {
  // 链首输入有界 2000 字（R11 票③ performance：IPv6 lookahead 在超长输入上 O(n²)——探针路径不卡事件循环；
  //  2000 字足以覆盖全部已知驱动报文形态；与「截断在脱敏后」不冲突——那是出口截断 120 字，这是入口护性能）
  const bounded = raw.length > 2000 ? raw.slice(0, 2000) : raw;
  return bounded
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ") // 控制字符+Unicode 格式符前置规范化（R12 票①+R26 票⑤：零宽/双向控制字符（Cf 类）\s 不匹配——拆 token 逃锚定 regex 的面封死）
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]+@/gi, "$1***:***@") // URL userinfo 密码段（R23 票③：空用户名形态 scheme://:pw@host——user 段 * 允许为空）（R21 票① high：mysql://root:s3cr3t@host——驱动报文回显连接串时密码不落地；user:pass 同抹，宁过不欠）
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/@]+@)[^\s/?#]+/gi, "$1***") // URL authority 主机[:port] 段（R22 票②：mysql://root:pw@dbprod/db 只抹凭据会漏主机名——主机段整段抹）
    .replace(/([a-z][a-z0-9+.-]*:\/\/)(?![^\s/?#]*@)[^\s/?#]+/gi, "$1***") // 无凭据 authority 主机段（R23 票④：mysql://dbprod/db / redis://cache-prod——无 @ 形态的主机段同抹）
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, "***") // IPv4[:port]
    .replace(/\bE[A-Z][A-Z_]{1,}\s+\S+/g, (m) => m.split(/\s/)[0] + " ***") // E 系错误码家族（R26 票④：EAI_NODATA/ENETUNREACH/EHOSTDOWN/ER_* 全形态——固定白名单永远列不全，家族化收口）
    .replace(/\[(?=[^\]]*:)[0-9a-zA-Z:%._-]+\](:\d+)?/g, "***") // 方括号 IPv6[:port] 含 zone（括号内需含 : 才抹——[error]/[INFO] 普通方括号词不误抹，R13 票③）
    .replace(/(?:[0-9a-f]{1,4}:){6,7}[0-9a-f]{1,4}(?:%[0-9a-zA-Z._-]+)?\b/gi, "***") // 纯数字 IPv6 全形态（≥6 冒号才抹，时间值安全）
    .replace(/(?:(?=[0-9a-f:]*[a-f])|(?=[0-9a-f:]*::))(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%[0-9a-zA-Z._-]+)?/gi, "***") // 含 hex 字母或 :: 压缩形态（zone 后缀随地址一并消费）
    .replace(/\b[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+(?::\d+)?\b/g, "***") // 点分主机名[:port] 先抹（R17 票①：裸 host:port 支若先跑会切断点分名尾标签；标签含下划线）
    .replace(/(?<![.\w-])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+:\d{2,5}\b/g, "***") // 裸 host:port 无点形态（R16+R17：(?<![.\w-]) 防切点分名尾标签；至少一字母——12:34 时间不误抹、2fa:3306 数字开头主机名照抹）
    .replace(/\bhost\s+'[^']*'/gi, "host '***'") // MySQL CR_UNKNOWN_HOST 形态（R17 票②：Unknown MySQL server host 'dbprod'——引号裸单标签无锚点漏面收口）
    .replace(/\bserver on '[^']*'/gi, "server on '***'") // MySQL CR_CONN_HOST_ERROR 形态（R22 票②：Can't connect to MySQL server on 'dbprod' (111)）
    .replace(/('(?:[^'\\]|\\.)*'@')[^']*'/g, "$1***'") // MySQL 账号报文 'user'@'host' 的 host 段（R13 票②：Access denied for user 'root'@'localhost' 形态——单标签主机名的最后漏面）
    .slice(0, 120); // 控制字符已在链首归一化（R13 票①：尾部重复剥除摘除——中间支只产 *** 不产控制字符，双写必漂移）
}
