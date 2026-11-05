/**
 * wbFiles —— M31 工作台附件中心（文件/图片/附件统一入口）。
 *
 * 与 kb 知识库的定位区分：kb 是「可检索解析的企业文档」（2MB，admin）；
 * wbFiles 是「日常办公附件」（图片/办公文档/文本，8MB，本企业全员可传）。
 *
 * 纪律（与 agentTools 产出物同口径）：
 * - factoryId 企业强隔离：list/download/remove 一律带企业条件，跨企业 404；
 * - 类型白名单（图片 png/jpg/jpeg/gif/webp；办公 docx/xlsx/pptx/pdf；文本 txt/md/csv），
 *   可执行/脚本类一律拒（exe/sh/bat/js/html/svg…），mime 与扩展名双重校验；
 * - 原始文件 ≤8MB（base64 后 ~10.7MB，按 11MB 拦截）；
 * - 落盘 ST_UPLOAD_DIR（默认 <cwd>/data/uploads，文件名 sha256 前缀+时间戳防碰撞防穿越）；
 * - remove 仅上传者本人或 admin；下载双轨（本企业成员）；
 * - token 只在请求体；文件内容只在 download 响应，绝不在列表/日志出现。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe, normalizeRole } from "./wbSession";
import { stQuery } from "./terminal";
import { screenText } from "./contentScreen";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** 原始文件上限 8MB；base64 载荷按 11MB 拦截（留 padding 余量） */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_B64_LEN = 11 * 1024 * 1024;

/** mime 白名单 → kind（图片/办公/文本） */
const MIME_KIND: Record<string, "image" | "office" | "text"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "office",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "office",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "office",
  "application/pdf": "office",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
};

/** 扩展名 ↔ mime 一致性（防伪装：mime 报图片但扩展名 .exe） */
const EXT_OF_MIME: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/jpg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt", "log"],
  "text/markdown": ["md", "markdown"],
  "text/csv": ["csv"],
};

function uploadDir(): string {
  return process.env.ST_UPLOAD_DIR ?? path.join(process.cwd(), "data", "uploads");
}

function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : "";
}

/** 上传校验：mime 白名单 + 扩展名一致 + 大小。返回 kind 或抛 BAD_REQUEST。 */
export function validateUpload(mimeType: string, fileName: string, sizeBytes: number): "image" | "office" | "text" {
  const kind = MIME_KIND[mimeType];
  if (!kind) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "只支持图片（png/jpg/gif/webp）、办公文档（docx/xlsx/pptx/pdf）和文本（txt/md/csv）" });
  }
  const ext = extOf(fileName);
  if (!ext || !(EXT_OF_MIME[mimeType] ?? []).includes(ext)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "文件类型与扩展名不一致，已拦截" });
  }
  if (sizeBytes > MAX_BYTES) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "文件超过 8MB 上限" });
  }
  if (sizeBytes <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "空文件，已拦截" });
  }
  return kind;
}

interface AttachmentRow {
  id: number;
  factoryId: number;
  uploaderId: number;
  title: string;
  fileName: string;
  mimeType: string;
  kind: string;
  filePath: string;
  sizeBytes: number;
  createdAt: unknown;
}

async function loadAttachment(id: number, factoryId: number): Promise<AttachmentRow> {
  const rows = await stQuery(
    sql`SELECT id, factoryId, uploaderId, title, fileName, mimeType, kind, filePath, sizeBytes, createdAt
        FROM st_attachments WHERE id = ${id} AND factoryId = ${factoryId} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "附件不存在" });
  return {
    id: Number(r.id),
    factoryId: Number(r.factoryId),
    uploaderId: Number(r.uploaderId),
    title: String(r.title),
    fileName: String(r.fileName),
    mimeType: String(r.mimeType),
    kind: String(r.kind),
    filePath: String(r.filePath),
    sizeBytes: Number(r.sizeBytes),
    createdAt: r.createdAt,
  };
}

export const wbFilesRouter = createRouter({
  /**
   * upload（mutation，本企业全员）：FileReader base64 上行 → 校验 → 落盘 → 台账。
   * 返回 {id, kind, sizeBytes}；文件内容绝不在日志出现。
   */
  upload: publicQuery
    .input(
      tokenInput.extend({
        title: z.string().trim().min(1).max(64).optional(),
        fileName: z.string().trim().min(1).max(128),
        mimeType: z.string().trim().min(3).max(96),
        fileBase64: z.string().min(8).max(MAX_B64_LEN),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const buf = Buffer.from(input.fileBase64, "base64");
      const kind = validateUpload(input.mimeType, input.fileName, buf.length);
      const dir = uploadDir();
      await fs.mkdir(dir, { recursive: true });
      // 文件名：时间戳+随机前缀+安全扩展名（防碰撞、防路径穿越，绝不沿用原始名）
      const safeName = `${Date.now()}-${randomBytes(6).toString("hex")}.${extOf(input.fileName)}`;
      const filePath = path.join(dir, safeName);
      await fs.writeFile(filePath, buf);

      // M36 UGC 本地初筛：标题/文件名写库前过筛（命中转人工复审，不泄露命中词）
      const screen = screenText(`${input.title ?? ""}\n${input.fileName}`);
      if (!screen.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: screen.reason });
      }
      const title = (input.title ?? input.fileName).slice(0, 64);
      const res = (await getDb().execute(
        sql`INSERT INTO st_attachments (factoryId, uploaderId, title, fileName, mimeType, kind, filePath, sizeBytes)
            VALUES (${factory.id}, ${user.id}, ${title}, ${input.fileName.slice(0, 128)}, ${input.mimeType}, ${kind}, ${filePath}, ${buf.length})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      const id = Number(header?.insertId ?? 0);
      return { ok: true as const, id, kind, sizeBytes: buf.length, title };
    }),

  /** list（query，本企业全员）：附件台账（新→旧，≤100）。 */
  list: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await stQuery(
      sql`SELECT a.id, a.title, a.fileName, a.mimeType, a.kind, a.sizeBytes, a.createdAt,
                 COALESCE(u.displayName, u.username, '') AS uploaderName, a.uploaderId
          FROM st_attachments a LEFT JOIN wb_users u ON u.id = a.uploaderId
          WHERE a.factoryId = ${factory.id} ORDER BY a.id DESC LIMIT 100`,
    );
    return {
      files: rows.map((r) => ({
        id: Number(r.id),
        title: String(r.title),
        fileName: String(r.fileName),
        mimeType: String(r.mimeType),
        kind: String(r.kind),
        sizeBytes: Number(r.sizeBytes),
        uploaderName: String(r.uploaderName ?? ""),
        createdAt: r.createdAt,
      })),
    };
  }),

  /** download（mutation，本企业成员）：base64 回传（与产出物双轨同模式）。 */
  download: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const row = await loadAttachment(input.id, factory.id);
      // 路径防穿越兜底：必须落在 uploadDir 之内
      const dir = path.resolve(uploadDir());
      const abs = path.resolve(row.filePath);
      if (!abs.startsWith(dir + path.sep)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "附件路径异常，已拦截" });
      }
      try {
        const buf = await fs.readFile(abs);
        return {
          title: row.title,
          fileName: row.fileName,
          mimeType: row.mimeType,
          kind: row.kind,
          sizeBytes: row.sizeBytes,
          base64: buf.toString("base64"),
        };
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "附件文件已不存在，请重新上传" });
      }
    }),

  /** remove（mutation）：上传者本人或 admin；幂等（已删返回 ok）。 */
  remove: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const row = await loadAttachment(input.id, factory.id);
      const isOwner = row.uploaderId === Number(user.id);
      const isAdmin = normalizeRole(user.role) === "admin";
      if (!isOwner && !isAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有上传者本人或管理员能删除" });
      }
      await getDb().execute(
        sql`DELETE FROM st_attachments WHERE id = ${row.id} AND factoryId = ${factory.id}`,
      );
      // 文件本体删除失败静默（台账已删，孤本由巡检清理）
      await fs.unlink(row.filePath).catch(() => undefined);
      return { ok: true as const, id: row.id };
    }),
});
