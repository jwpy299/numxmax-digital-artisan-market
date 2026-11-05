/**
 * 吊销台账列宽双端单源（批七 R7-c8-⑤）：revoked_by/reason 两列宽与 db/sync-auth-lock.mts 的 DDL 同源——
 *  改宽改本表，钳宽/DDL 不再两处各抄（太宽 ER_DATA_TOO_LONG 复活假吊销；太窄静默截断审计面）。
 */
/** token sha256 hex 定长 64：指纹列宽独立常量（R7-c10-①），绝不随 revoked_by 改宽——指纹列误随 REVOKED_BY_MAX 收窄即 ER_DATA_TOO_LONG 假吊销复活 */
export const FINGERPRINT_MAX = 64;
export const REVOKED_BY_MAX = 64;
export const REASON_MAX = 256;
/** 登录统一失败话术（门禁 PR#9-r26-⓪）：双端单源——adminAuth/staff 服务端两族+wbSession 客户端判别前缀同引
 *  （跨层字串契约归本叶——措辞演进编译期两端同步，不再隐形耦合两处裸字面量） */
export const AUTH_LOGIN_FAIL_GENERIC = "账号或密码错误";
/** 2FA 要码弹窗话术（门禁 PR#9-r29-①）：双端单源——服务端 verify2faCode 412 抛出+客户端 AdminLogin 空文回落同引（复述漂移面封死） */
export const AUTH_2FA_REQUIRED_MESSAGE = "该账号已启用二次验证——请输入动态码";
/** 2FA 失败节流参数+锁定话术（门禁 PR#9-r29-①）：窗长/阈值/话术三件套归叶——adminAuth SQL 窗判+wbSession 429 空文回落同引 */
export const TFA_FAIL_WINDOW_S = 600;
export const TFA_FAIL_MAX = 5;
export const TFA_LOCKED_MESSAGE = `二次验证失败次数过多——已临时锁定（${TFA_FAIL_WINDOW_S / 60} 分钟后再试）`;
/** 部署闸脚本路径常量（R7-c135-①）：操作向告警/留痕插值同引——改名失联=运维指令静默失真面封死（跨模块字面量各持即此面） */
export const SYNC_AUTH_LOCK_SCRIPT = "db/sync-auth-lock.mts";
/** 2FA 台账迁移脚本路径（门禁 PR#9-r16-①）：adminAuth 装表指引 412+缺表告警两处同引——同类单源纪律（改名失联=运维指令静默失真面封死） */
export const SYNC_ADMIN_2FA_SCRIPT = "db/sync-admin-2fa.mts";
/** 2FA 装表指引话术（门禁 PR#9-r31-②）：enroll/confirm/disable/reset2fa 四端点同引（不再三处复抄漂移） */
export const TFA_TABLE_MISSING_MESSAGE = `2FA 数据表未初始化，请先执行 ${SYNC_ADMIN_2FA_SCRIPT}`;
/** 2FA 码校验失败话术（门禁 PR#9-r31-②）：setPassword/reset2fa/disable2fa 同引；confirm 装设径带指引尾（下方变体常量） */
export const TFA_CODE_FAIL_MESSAGE = "动态码校验失败";
export const TFA_CODE_FAIL_SETUP_MESSAGE = "动态码校验失败——请核对扫码密钥与设备时钟";
/** wb 侧登录通用败话术（门禁 PR#9-r31-⓪）：agentic.authLogin 服务端抛出+AdminLogin 通用败排除集同引（跨层契约） */
export const AUTH_WB_LOGIN_FAIL_GENERIC = "手机号/用户名或密码错误";
/** 管理员权限统一话术（门禁 PR#9-r31-⓪）：自 identity.ts 下沉本叶——AdminLogin 客户端判别同引（纯常量叶双端可引） */
export const ADMIN_REQUIRED_MESSAGE = "需要管理员权限";
// 门禁 PR#9-r35-③：AUTH_GENERIC_FAIL_PREFIXES/isGenericAuthFailMessage 一轮即退役——deny-list 是开放面（r35-③ security medium）；
//  由 AUTH_DELIBERATE_401_PREFIXES 白名单+wbSession.extractDeliberateAuthMessage 取代（未登记 401 话术一律不直呈）
/** 401 刻意个案白名单（门禁 PR#9-r35-③ security medium）：客户端只直呈名单内服务端话术——deny-list 是开放面
 *  （新服务端 401 默认不直呈=guard/节流/漂移新话术不裸泄给未认证面）；服务端加面向用户的 401 话术须先归本表 */
/** 401 停用个案话术双件（门禁 PR#9-r36-⑥）：服务端抛出点（adminAuth 超终/staff 员工轨）与白名单同叶同引——
 *  白名单前缀不再是手抄字面量（改名/加尾两端编译期锁步） */
export const AUTH_DISABLED_SUPER_MESSAGE = "账号已被停用，请联系超级管理员";
export const AUTH_DISABLED_DEPT_MESSAGE = "账号已被停用，请联系部门负责人或管理员";
export const AUTH_DELIBERATE_401_PREFIXES = [AUTH_DISABLED_SUPER_MESSAGE, AUTH_DISABLED_DEPT_MESSAGE] as const; // 门禁 PR#9-r36-⑥：白名单同引双件常量（不再手抄前缀）
/** TOTP issuer 默认值（门禁 PR#9-r36-④）：品牌字单源——adminAuth 的 env.totpIssuer 空值回落同引（白标/换牌只配 env 或改本叶） */
export const TOTP_ISSUER_DEFAULT = "NebulaHQ";
/** 登录面其余用户话术（门禁 PR#9-r34-⓪③）：wbSession 分流件回落+AdminLogin 内联字面量全归叶 */
export const AUTH_LOGIN_FAIL_WITH_TOTP = '账号、密码或动态码错误，请核对后重试'; // 已提交码的 401 放宽措辞（wbSession 分流件用）
export const AUTH_LOGIN_FAIL_CLIENT = '账号或密码错误，或权限不足'; // AdminLogin 通用口径（原页面内联 LOGIN_FAIL_MSG 归叶）
export const AUTH_INPUT_INVALID_MESSAGE = '输入格式不合法——请检查账号/密码/动态码后重试';
export const AUTH_INFRA_MESSAGE = '服务暂不可用——请稍后重试或联系运维';
export const AUTH_TRANSPORT_MESSAGE = '网络或服务暂不可用——请稍后重试';
export const AUTH_SESSION_PERSIST_FAIL_MESSAGE = '登录成功但本地会话保存失败——请检查浏览器存储/隐私设置后重试';
export const AUTH_NAVIGATE_FAIL_MESSAGE = '登录成功——自动跳转失败，请手动访问 /admin'; // 门禁 PR#9-r37-②：导航败与保存败分讯
/** token 入参上限单源（R7-c39-⑥）：128=最宽 token 列（st_admin_accounts VARCHAR(128)；wb_users 80/staff 64）——
 *  列加宽改本表，zod 闸不再手抄漂移（目标值只进 sha256+参数化 UPDATE，上限仅防敞口）——四族列宽：wb_users 80/staff 64/dev 64/st_admin 128（R7-c42-⑫ 互锁钉） */
export const TOKEN_MAX = 128;

/** 归一化口径标记行指纹（R7-c117-①）：sync-auth-lock 部署闸写入+boot 口径体检读取同引——跨模块契约不再各持字面量（改名失联=体检静默失效面封死） */
export const REVOCATION_SCHEME_MARKER = "scheme:normalized-v1";


/** 台账不可达统一话术（R7-c19-③/R7-c134-⑥：单源——自 identity 下沉本叶，revocation 同引不成环）：
 *  安全敏感——避开 isWbAuthError 正则（token 无效|未登录|已失效）；多处调用同引本常量，单点漂移即被看见，不改客户端清会话行为 */
export const LEDGER_UNAVAILABLE_MESSAGE = "权限台账暂不可达，请稍后重试";

/** 行级口径标签（R7-c154-⑥ security medium 收口）：逐行 scheme 标记——「64-hex 双口径不可逐行分辨」结构性盲区封死
 *  （旧口径/带外写入行=scheme_tag 缺/异——运行期与体检可检）；marker 行 fingerprint 系哨兵常量不入本标签 */
export const REVOCATION_ROW_TAG = "norm-v1";

/** 审计关联 id 截断长（R7-c114-④）：st_user_audit.target_id 列宽族单源——authLock 同引（列宽演进不再各持字面量） */
export const AUDIT_TARGET_ID_LEN = 16;

/** CI 列等价归一化单点（R7-c110-⑦）：utf8mb4_*_ci 列语义对齐——trim+小写+NFD 去组合符（大小写/口音/空白变体同值）；
 *  tokenFingerprint/委派绑定报告等比对同引（三份手抄归一化=漂移面封死）；contracts 叶纯数据——identity/revocation/boot 三方同引不成环 */
export function normalizeCiText(s: string): string { // R7-c114-④：形参收窄 string——null/undefined 不再静默映射成字面量 "null"/"undefined"（台账键/标签 bogus 值面封死；行字段调用方先 String() 显式化）
  return s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
