/**
 * 管理台扫码登录：有效会话 + 短 TTL + 显式人工确认 + 双证/IP 绑定 + 一次性取 token。
 * 共享表 wb_token_enc 为历史列名；target='admin_console' 时明确保存管理 token。
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "../queries/rawRows";
import { requireAdmin } from "../auth/adminGate";
import { newCredential, sha256 } from "./wbSession";
import { encryptQrToken, decryptQrToken } from "./qrLoginCrypto";
import { QR_SESSION_RE, newQrSession } from "../lib/qrSession";
import { guardInfra } from "../auth/identity";
import { affectedRowsOf } from "../lib/dbResult";
import { ensureQrSessions, adminQrRateOk, cleanupAdminQrThrottled, adminQrExpiresAt, QR_TTL_MIN } from "./qrLoginShared";
import { Paths } from "@contracts/constants";
import { adminConsoleId, adminConsoleProof, buildAdminConsoleQrText, verifyAdminConsoleProof, ADMIN_CONSOLE_ID_RE } from "./adminQrProof";

const CONSOLE_NAME = "NumX Max·门户管理台";
const tokenInput = z.object({ token: z.string().trim().min(1) });
const sessionInput = z.string().trim().regex(QR_SESSION_RE, "会话格式不正确");

function sameSha256(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const QR_LOG_TTL_MS = 60_000;
const qrLogSeen = new Map<string, number>();
function logQr(action: string, session: string, result: string): void {
  const key = `${action}|${session}|${result}`;
  const now = Date.now();
  const last = qrLogSeen.get(key) ?? 0;
  if (now - last < QR_LOG_TTL_MS) return;
  qrLogSeen.set(key, now);
  if (qrLogSeen.size > 1024) qrLogSeen.clear(); // 有界防膨胀；安全事件按结果分组节流，不逐轮询刷屏
  console.info(`[adminQr] ${action} session=…${session.slice(-6)} result=${result}`);
}

const RATE_CAPS: Record<"open" | "confirm" | "status", [number, number]> = { open: [10, 200], confirm: [20, 400], status: [120, 2000] };

async function checkRate(db: ReturnType<typeof getDb>, action: "open" | "confirm" | "status", ip: string): Promise<string> {
  if (!ip) throw new TRPCError({ code: "BAD_REQUEST", message: "无法识别请求来源——扫码会话不建立" });
  const caps = RATE_CAPS[action];
  if (!(await adminQrRateOk(db, action, ip, caps[0], caps[1]))) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "操作过于频繁——请稍后再试" });
  }
  return ip;
}

export const adminQrLoginRouter = createRouter({
  open: publicQuery
    .input(z.object({ target: z.literal("admin_console").default("admin_console") }))
    .mutation(async ({ input, ctx }) => {
      return guardInfra("adminQr.open", async () => {
        await ensureQrSessions();
        const db = getDb();
        const ip = await checkRate(db, "open", ctx.clientIp ?? "");
        await cleanupAdminQrThrottled(db);
        const session = newQrSession();
        const pollSecret = newCredential("qs_");
        const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
        const expiresAt = adminQrExpiresAt(createdAt);
        const consoleId = adminConsoleId();
        const consoleProof = adminConsoleProof(session, consoleId, expiresAt);
        const qrText = buildAdminConsoleQrText(session, expiresAt);
        await db.execute(sql`INSERT INTO st_qr_sessions (session, target, client_ip, poll_secret_hash, created_at) VALUES (${session}, ${input.target}, ${ip}, ${sha256(pollSecret)}, ${createdAt})`);
        logQr("open", session, "created");
        return { ok: true as const, session, pollSecret, target: input.target, consoleName: CONSOLE_NAME, consoleId, consoleProof, sessionHint: session.slice(-6), expiresInSec: QR_TTL_MIN * 60, expiresAt, qrText, imagePath: Paths.adminQrImage };
      });
    }),

  /** APP 明示确认：必须展示 CONSOLE_NAME+sessionHint 并由管理员主动确认后才许传 consent。 */
  confirm: publicQuery
    .input(tokenInput.extend({
      session: sessionInput,
      consoleId: z.string().trim().regex(ADMIN_CONSOLE_ID_RE),
      consoleProof: z.string().trim().regex(/^[0-9a-f]{32}$/),
      expiresAt: z.number().int().positive(),
      consent: z.literal("admin_console_confirmed"),
    }))
    .mutation(async ({ input, ctx }) => {
      return guardInfra("adminQr.confirm", async () => {
        await ensureQrSessions();
        const db = getDb();
        await checkRate(db, "confirm", ctx.clientIp ?? "");
        if (!verifyAdminConsoleProof(input.session, input.consoleId, input.expiresAt, input.consoleProof)) {
          logQr("confirm", input.session, "console_proof_rejected");
          throw new TRPCError({ code: "FORBIDDEN", message: "管理台实例或签名不一致——请回真实管理台重新出码" });
        }
        await requireAdmin(input.token);
        const rows = rawRows(await db.execute(sql`SELECT id, state, created_at FROM st_qr_sessions WHERE session=${input.session} AND target='admin_console' LIMIT 1`)) as Array<Record<string, unknown>>;
        const row = rows[0] as { id: number; state: string; created_at: Date } | undefined;
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "扫码会话不存在或已过期——请管理台重新出码" });
        if (input.expiresAt !== adminQrExpiresAt(row.created_at)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "签名有效期与会话不一致——请重新出码" });
        }
        if (row.state !== "pending") throw new TRPCError({ code: "CONFLICT", message: "该码已被使用或过期——请管理台重新出码" });
        if (Date.now() > adminQrExpiresAt(row.created_at)) {
          await db.execute(sql`UPDATE st_qr_sessions SET state='expired' WHERE id=${row.id} AND state='pending'`);
          throw new TRPCError({ code: "BAD_REQUEST", message: "二维码已过期——请管理台重新出码" });
        }
        const upd = await db.execute(sql`UPDATE st_qr_sessions SET state='confirmed', wb_token_enc=${encryptQrToken(input.token)}, confirmed_at=NOW() WHERE id=${row.id} AND state='pending' AND target='admin_console'`);
        if (affectedRowsOf(upd) !== 1) throw new TRPCError({ code: "CONFLICT", message: "扫码会话状态已变化——请重新出码" });
        logQr("confirm", input.session, "human_consent_confirmed");
        return { ok: true as const, consoleName: CONSOLE_NAME, sessionHint: input.session.slice(-6) };
      });
    }),

  status: publicQuery
    .input(z.object({ session: sessionInput, pollSecret: z.string().trim().min(1).max(80).optional() }))
    .mutation(async ({ input, ctx }) => {
      return guardInfra("adminQr.status", async () => {
        await ensureQrSessions();
        const db = getDb();
        const callerIp = await checkRate(db, "status", ctx.clientIp ?? "");
        await cleanupAdminQrThrottled(db);
        const rows = rawRows(await db.execute(sql`SELECT id, state, target, created_at, poll_secret_hash, client_ip, wb_token_enc FROM st_qr_sessions WHERE session=${input.session} AND target='admin_console' LIMIT 1`)) as Array<Record<string, unknown>>;
        const row = rows[0] as { id: number; state: string; target: string; created_at: Date; poll_secret_hash?: string; client_ip?: string; wb_token_enc?: string } | undefined;
        if (!row) return { state: "expired" as const };
        if (["pending", "confirmed"].includes(row.state) && Date.now() > adminQrExpiresAt(row.created_at)) {
          await db.execute(sql`UPDATE st_qr_sessions SET state='expired', wb_token_enc=NULL WHERE id=${row.id} AND state IN ('pending','confirmed')`);
          logQr("status", input.session, "expired");
          return { state: "expired" as const };
        }
        if (row.state === "confirmed") {
          const expectHash = String(row.poll_secret_hash ?? "");
          if (!input.pollSecret || !sameSha256(sha256(input.pollSecret), expectHash)) {
            logQr("status", input.session, "pending");
            return { state: "pending" as const };
          }
          const openIp = String(row.client_ip ?? "");
          if (!callerIp || !openIp) {
            logQr("status", input.session, "ip_unavailable_terminal");
            return { state: "unavailable" as const };
          }
          if (callerIp !== openIp) {
            logQr("status", input.session, "ip_mismatch_terminal");
            return { state: "ip_mismatch" as const };
          }
          const encText = String(row.wb_token_enc ?? "");
          const token = encText ? decryptQrToken(encText) : null;
          if (!token) {
            // 配置缺钥会 throw 并走脱敏 500，不到这里；只有坏密文才销毁，避免每次轮询重复解同一死档。
            await db.execute(sql`UPDATE st_qr_sessions SET state='expired', wb_token_enc=NULL WHERE id=${row.id} AND state='confirmed'`);
            logQr("status", input.session, "cipher_unavailable_burned");
            return { state: "expired" as const };
          }
          const upd = await db.execute(sql`UPDATE st_qr_sessions SET state='consumed', wb_token_enc=NULL WHERE id=${row.id} AND state='confirmed'`);
          if (affectedRowsOf(upd) !== 1) return { state: "consumed" as const };
          logQr("status", input.session, "token_released_once");
          return { state: "confirmed" as const, token, target: row.target };
        }
        logQr("status", input.session, row.state);
        return { state: row.state as "pending" | "expired" | "consumed" };
      });
    }),
});
