/**
 * betaApply —— 邀请内测报名通道（彭总 2026-10-01 令：门户开报名+超终审批）。
 *
 * 四环闭环：门户 /apply 报名（手机验真）→ st_beta_applications 台账 pending →
 * 超终审批（/admin/beta）→ 批准即签 iv_ 内测码（HQ 厂 d1·staff·168h——beta-check 现成认）；
 * 码明文仅批准响应本次出示（审批卡复制钮人工发；短信通知挂账 P-SMS-TPL——阿里云通知模板审批在途）。
 *
 * 纪律：报名验真手机（sms beta_apply purpose 验证码消费）；同号幂等（未审批重报=更新需求不重复开单）；
 * IP 限频防爆破；台账全程留痕（approved/rejected+审批人+时间）；驳回不落码不泄名单。
 */
import { z } from "zod";
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { BETA_KINDS } from "@contracts/betaKinds"; // 分流身份枚举跨栈单源（portal#56 复审票：SQL 内联字面量与契约脱勾面封死——引契约参数绑定）
import {
  consumeSmsCodeById,
  phoneSchema,
  SMS_CODE_RE,
  verifySmsCodeOnly,
} from "./smsVerify";
import { sendSmsNotice } from "./sms";
import { ensureBetaInvites, withBetaInvitePhoneLock } from "./betaInvites";
import { newCredential } from "./wbSession";
import { requireAdmin } from "./terminal";

// HQ_FACTORY_ID 退役（彭总令：资格码面不挂厂——st_beta_invites 独立承载）
const BETA_INVITE_TTL_HOURS = 168; // 内测码 7 天有效

/** 幂等建表（sync 面同族口径） */
async function ensureBetaApplications(): Promise<void> {
  // 内测资格码表（彭总令：注册资格闸——与 wb_invites 入企码分家）；DDL 走 betaInvites 单源（门禁票：双份复刻摘）
  await ensureBetaInvites();
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_beta_applications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      enterprise_name VARCHAR(128) NOT NULL,
      contact_name VARCHAR(64) NOT NULL,
      phone VARCHAR(32) NOT NULL,
      industry VARCHAR(64) NOT NULL,
      headcount VARCHAR(32) NOT NULL,
      need VARCHAR(500) NOT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      invite_code VARCHAR(80) NULL,
      reviewed_by VARCHAR(64) NULL,
      review_note VARCHAR(300) NULL,
      reviewed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_phone (phone),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

export const betaApplyRouter = createRouter({
  /** submit（公开）：报名表单——验短信码真+幂等落库 pending */
  submit: publicQuery
    .input(
      z.object({
        enterpriseName: z.string().trim().min(2).max(128),
        contactName: z.string().trim().min(1).max(64),
        phone: phoneSchema,
        code: z.string().trim().regex(SMS_CODE_RE, "验证码格式不正确"),
        industry: z.string().trim().min(1).max(64),
        headcount: z.string().trim().min(1).max(32),
        need: z.string().trim().min(1).max(500),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await ensureBetaApplications();
        const db = getDb();
        // 验码两段式同口径（计数直提交不被后续失败吞）；报名无事务面——验后即刻按行消费
        const { rowId: smsRowId } = await verifySmsCodeOnly(
          db,
          input.phone,
          "beta_apply",
          input.code,
        );
        await consumeSmsCodeById(db, smsRowId);
        // 同号幂等：已有 pending 申请→更新需求面不重复开单；已批准→提示查短信/联系渠道
        const exist = rawRows(
          await db.execute(
            sql`SELECT id, status FROM st_beta_applications WHERE phone=${input.phone} LIMIT 1`,
          ),
        ) as Array<{ id: number; status: string }>;
        if (exist.length > 0) {
          if (exist[0].status === "pending") {
            await db.execute(sql`
            UPDATE st_beta_applications SET enterprise_name=${input.enterpriseName}, contact_name=${input.contactName},
              industry=${input.industry}, headcount=${input.headcount}, need=${input.need}
            WHERE id=${exist[0].id}`);
            return { ok: true, reused: true };
          }
          if (exist[0].status === "approved") {
            return {
              ok: true,
              reused: true,
              note: "你的申请已批准过——内测码已发出，没收到请联系灵智枢渠道",
            };
          }
          // rejected：允许重新申请（覆盖回 pending 重审）
          await db.execute(sql`
          UPDATE st_beta_applications SET enterprise_name=${input.enterpriseName}, contact_name=${input.contactName},
            industry=${input.industry}, headcount=${input.headcount}, need=${input.need},
            status='pending', reviewed_by=NULL, review_note=NULL, reviewed_at=NULL
          WHERE id=${exist[0].id}`);
          return { ok: true, reused: true };
        }
        await db.execute(sql`
        INSERT INTO st_beta_applications (enterprise_name, contact_name, phone, industry, headcount, need)
        VALUES (${input.enterpriseName}, ${input.contactName}, ${input.phone}, ${input.industry}, ${input.headcount}, ${input.need})`);
        return { ok: true, reused: false };
      } catch (e) {
        // TRPCError（验码等业务错）原样抛——文案已友好；DB/意外错原文绝不吐前端（安全钉：SQL+params 含手机号明文=泄露面封死）
        if (e instanceof TRPCError) throw e;
        console.error(
          "[beta-apply] submit failed:",
          (e as Error)?.message ?? e,
        ); // 服务端留痕
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "提交失败，请稍后重试或联系灵智枢渠道",
        });
      }
    }),

  /** adminList（超终 admin 闸）：申请列表（默认 pending 在前） */
  adminList: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        status: z
          .enum(["pending", "approved", "rejected", "all"])
          .default("pending"),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      await ensureBetaApplications();
      const db = getDb();
      const rows = rawRows(
        input.status === "all"
          ? await db.execute(
              sql`SELECT * FROM st_beta_applications ORDER BY status='pending' DESC, id DESC LIMIT 200`,
            )
          : await db.execute(
              sql`SELECT * FROM st_beta_applications WHERE status=${input.status} ORDER BY id DESC LIMIT 200`,
            ),
      );
      return { rows };
    }),

  /** review（超终 admin 闸）：批准=签 iv_ 码+台账 approved（码明文仅本次响应出示）；驳回=落 reason */
  review: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        id: z.number().int().positive(),
        approve: z.boolean(),
        reason: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      await ensureBetaApplications();
      const db = getDb();
      const rows = rawRows(
        await db.execute(
          sql`SELECT id, status, contact_name, phone FROM st_beta_applications WHERE id=${input.id} LIMIT 1`,
        ),
      ) as Array<{
        id: number;
        status: string;
        contact_name: string;
        phone: string;
      }>;
      if (rows.length === 0)
        throw new TRPCError({ code: "NOT_FOUND", message: "申请不存在" });
      if (rows[0].status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该申请已审过" });
      }
      const adminName = String(
        (admin as { username?: string }).username ?? "admin",
      );
      if (!input.approve) {
        await db.execute(sql`
          UPDATE st_beta_applications SET status='rejected', reviewed_by=${adminName},
            review_note=${input.reason ?? null}, reviewed_at=NOW() WHERE id=${input.id}`);
        return { ok: true, approved: false };
      }
      // 批准：签 iv_ 内测码（资格码面——st_beta_invites：注册资格闸，验真消费不入企；彭总 2026-10-02 令语义分家）
      const code = newCredential("iv_");
      const codeHash = createHash("sha256").update(code).digest("hex");
      // 签发+台账同事务（门禁票：两写不原子=半态面）；phone 用首查行（不再二次查——空兜底插无效数据面封死）
      await withBetaInvitePhoneLock(rows[0].phone, async (tx) => {
        // 先 UPDATE 带 pending 守卫（门禁票：INSERT 先跑=重复批准重签码面）——影响行=0 即已被并发审过，整事务回滚不签码
        const upd = await tx.execute(sql`
          UPDATE st_beta_applications SET status='approved', invite_code=${code.slice(0, 12) + "…"},
            reviewed_by=${adminName}, reviewed_at=NOW() WHERE id=${input.id} AND status='pending'`);
        if (
          Number(
            (upd[0] as { affectedRows?: number | string } | undefined)
              ?.affectedRows ?? 0,
          ) !== 1
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "该申请已审过" });
        }
        await tx.execute(sql`
          INSERT INTO st_beta_invites (phone, codeHash, expires_at, kind)
          VALUES (${rows[0].phone}, ${codeHash}, DATE_ADD(NOW(), INTERVAL ${BETA_INVITE_TTL_HOURS} HOUR), ${BETA_KINDS[1]})`); // kind 落 enterprise（审批流=企业报名面）——契约参数绑定（portal#56 复审票：SQL 内联字面量与契约脱勾=改名编译不报错静默脱勾面封死）
      });
      // 批准即发短信通知（奕信通自定义内容——彭总 2026-10-01 令：「我们不是有翼讯通吗」；
      // 失败静默不阻断审批——审批卡照出码人工可补发；台账挂账 P-SMS-TPL 退役）
      const smsSent = await sendSmsNotice(
        rows[0].phone,
        // PORTAL_URL env 覆盖面（env 名与仓内口径统一；缺省回退主域带 scheme——门禁票）
        `恭喜你通过 NumX Max 内测审核！邀请码：${code}（7 天有效）。电脑访问 ${process.env.PORTAL_URL ?? "https://downloads.example.invalid"} 下载桌面智能工作台，注册时填入此码；登录后扫码下载手机 APP。——广东灵智枢生态科技`,
      );
      return {
        ok: true,
        approved: true,
        inviteCode: code,
        ttlHours: BETA_INVITE_TTL_HOURS, // 口径修（门禁票：BETA_CODE_TTL_MS 是验证码 5 分钟面，码签的是 168h——用 invite TTL 常量）
        smsSent,
      };
    }),
});
