/**
 * kb —— 迭代 20「企业知识库（st_kb_docs）」服务端路由。
 *
 * 模块构成：upload / list / remove / context（全部 requireAdmin，token 仅请求体）。
 *
 * 约定（与 terminal.ts / staff.ts 一致）：
 * - 新表（st_kb_*）由 db/sync-kb.mts 幂等创建，本文件一律 raw SQL 访问，不改 drizzle schema；
 * - 上传限 2MB（base64 后约 2.7MB，超限拒绝并中文提示）；
 * - .txt/.md/.markdown 直接 utf8 解码入 textContent；.pdf/.docx/.doc 仅存档
 *   （textContent 为空、status ready、failReason 注明「该格式已存档，暂不参与智能问答解析」）；
 *   其余扩展名 BAD_REQUEST；
 * - kb.context 供智能客服/驻部智能体引用：拼接全部 status=ready 且有 textContent 的文档，
 *   clip 到 6000 字；loadKbContext() 同时被 wechat 应答逻辑复用。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { isNoSuchTable, infraUnavailable500 } from "../auth/identity"; // ④逐点核：canonical 政策件同引
import { getDb } from "../queries/connection";
import { requireAdmin, rawRows, clip } from "./terminal";
import { requireStaff } from "./staff";
import { markDeprecated } from "./deprecation";

const tokenInput = z.object({ token: z.string().trim().min(1) });

const KB_TABLES_HINT = "企业知识库数据表未初始化，请先在服务器执行 db/sync-kb.mts 后再操作";

/** 上传上限：原始文件 2MB（base64 后约 2.7MB，留余量按 2.8MB 拦截） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_LEN = 2_800_000;

/** 可直接 utf8 解码的扩展名 */
const TEXT_EXTS = new Set([".txt", ".md", ".markdown"]);
/** 迭代 38：真解析（docx 走 mammoth，pdf 走 pdf-parse，失败落 failReason） */
const PARSE_EXTS = new Set([".docx", ".pdf"]);
/** 仅存档、暂不参与解析的扩展名（迭代 38：xls/图片） */
const ARCHIVE_EXTS = new Set([".doc", ".xlsx", ".xls", ".png", ".jpg", ".jpeg"]);
const ARCHIVE_NOTE = "该格式已存档，暂不参与智能问答解析";

/** 解析 docx/pdf 为纯文本；失败返回 null（failReason 留痕） */
async function extractText(ext: string, buf: Buffer): Promise<string | null> {
  try {
    if (ext === ".docx") {
      const mammoth = await import("mammoth");
      const res = await mammoth.extractRawText({ buffer: buf });
      return res.value?.trim() || null;
    }
    if (ext === ".pdf") {
      const mod = (await import("pdf-parse")) as unknown as {
        PDFParse: new (opts: { data: Buffer }) => {
          getText: () => Promise<{ text: string }>;
          destroy: () => Promise<void>;
        };
      };
      const parser = new mod.PDFParse({ data: buf });
      const res = await parser.getText();
      await parser.destroy().catch(() => undefined);
      return res.text?.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// ─── 迭代 38：敏感信息掩码（展示层；原文落库不进日志）────────────────────────
/** 命中 15–18 位长数字串（身份证/银行卡口径）即掩码为前3后2 */
export function maskSensitive(text: string): string {
  return text.replace(/\d{3}(\d{10,13})[\dXx]{2}/g, (m) => `${m.slice(0, 3)}${"*".repeat(Math.max(m.length - 5, 8))}${m.slice(-2)}`);
}
/** 是否命中敏感长数字（用于上传提示） */
export function hasSensitive(text: string): boolean {
  return /\d{15,18}[\dXx]?/.test(text);
}

/**
 * 引用埋点（确权）：写 st_dept_doc_refs + usedCount+1。
 * 供 terminal.ts（swarm/会议）等调用；表缺失静默跳过，不阻断主流程。
 */
export async function recordDocRefs(
  docIds: number[],
  usedBy: "chat" | "meeting" | "swarm" | "skill",
  refId: string,
  actor: string,
  agentSeatId?: number | null,
): Promise<void> {
  if (docIds.length === 0) return;
  try {
    const db = getDb();
    for (const id of docIds) {
      await db.execute(
        sql`INSERT INTO st_dept_doc_refs (docId, usedBy, refId, agentSeatId, actor)
            VALUES (${id}, ${usedBy}, ${refId}, ${agentSeatId ?? null}, ${actor})`,
      );
    }
    await db.execute(
      sql`UPDATE st_kb_docs SET usedCount = usedCount + 1 WHERE id IN (${sql.join(
        docIds.map((d) => sql`${d}`),
        sql`, `,
      )})`,
    );
  } catch {
    // 留痕失败不阻断主流程
  }
}

/** st_kb_ 表查询统一兜底：表缺失时给出友好提示（④逐点核对齐 wb canonical：cause 链判别+500 掩码——死代码/裸泄双面同修） */
async function kbQuery(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch (err) {
    if (isNoSuchTable(err)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: KB_TABLES_HINT });
    }
    infraUnavailable500("[routers/kb] st_kb_ 查询失败（1146 以外）", err);
  }
}

// ─── 迭代 28：部门知识库双轨鉴权（admin 全局 / staff 本部门）──────────────────
export type KbActor =
  | { kind: "admin"; displayName: string }
  | { kind: "staff"; displayName: string; deptKey: string; role: "head" | "staff" };

/** 双轨鉴权：先 requireAdmin（全局），失败再 requireStaff（本部门） */
async function kbActor(token: string): Promise<KbActor> {
  try {
    const admin = await requireAdmin(token);
    return { kind: "admin", displayName: String(admin.displayName ?? admin.username ?? "admin") };
  } catch (err) {
    if (!(err instanceof TRPCError)) throw err;
  }
  const staff = await requireStaff(token);
  return { kind: "staff", displayName: staff.displayName, deptKey: staff.deptKey, role: staff.role };
}

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i).toLowerCase() : "";
}

/**
 * 拼接全部 status=ready 且有 textContent 的知识库文档，clip 到 maxChars 字。
 * 供 kb.context 与 wechat.answerWithKb 共用；表未初始化/查询失败一律回退空串（不抛错）。
 */
export async function loadKbContext(maxChars = 6000): Promise<string> {
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT title, textContent FROM st_kb_docs
            WHERE status = 'ready' AND textContent IS NOT NULL AND CHAR_LENGTH(textContent) > 0
            ORDER BY id ASC LIMIT 200`,
      ),
    );
    const parts = rows.map((r) => `【${clip(String(r.title), 60)}】\n${String(r.textContent)}`);
    return clip(parts.join("\n\n"), maxChars);
  } catch {
    return "";
  }
}

export const kbRouter = createRouter({
  /** 上传文档：FileReader base64 → 按扩展名解析/存档 */
  upload: publicQuery
    .input(
      tokenInput.extend({
        title: z.string().trim().max(200).optional(),
        fileName: z.string().trim().min(1, "文件名不能为空").max(255),
        fileBase64: z.string().min(1, "文件内容为空"),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await kbActor(input.token);
      if (input.fileBase64.length > MAX_BASE64_LEN) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "文件超过 2MB 上限，请压缩或拆分后再上传",
        });
      }
      const ext = extOf(input.fileName);
      if (!TEXT_EXTS.has(ext) && !PARSE_EXTS.has(ext) && !ARCHIVE_EXTS.has(ext)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "不支持的文件格式，仅支持 txt / md / pdf / docx / doc / xlsx / xls / png / jpg",
        });
      }
      const buf = Buffer.from(input.fileBase64, "base64");
      if (buf.length > MAX_FILE_BYTES) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "文件超过 2MB 上限，请压缩或拆分后再上传",
        });
      }
      const isText = TEXT_EXTS.has(ext);
      const isParse = PARSE_EXTS.has(ext);
      let textContent: string | null = isText ? buf.toString("utf8") : null;
      let failReason: string | null = null;
      if (isParse) {
        textContent = await extractText(ext, buf);
        if (!textContent) failReason = "解析失败，已存档原件";
      } else if (!isText) {
        failReason = ARCHIVE_NOTE;
      }
      const title = input.title?.trim() || input.fileName;
      const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
      const uploadedBy = actor.displayName;
      // 迭代 28：admin 上传为全局共享（dept_key=NULL）；staff 上传归属本部门
      const deptKey = actor.kind === "staff" ? actor.deptKey : null;

      const res = (await getDb().execute(
        sql`INSERT INTO st_kb_docs (title, fileName, mimeType, sizeBytes, textContent, status, failReason, uploadedBy, dept_key)
            VALUES (${title}, ${input.fileName}, ${mimeType}, ${buf.length},
                    ${textContent}, 'ready', ${failReason}, ${uploadedBy}, ${deptKey})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      return {
        id: Number(header?.insertId ?? 0),
        title,
        fileName: input.fileName,
        sizeBytes: buf.length,
        status: "ready" as const,
        parsedChars: textContent?.length ?? 0,
        archivedOnly: !textContent,
        deptKey,
        // 迭代 38：敏感信息命中提示（原文不落日志，展示层掩码）
        sensitiveHit: isText && textContent ? hasSensitive(textContent) : false,
      };
    }),

  /** 文档列表：不返回 textContent 全文，仅前 200 字摘要 */
  list: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await kbActor(input.token);
    // 迭代 28：admin 看全部；staff 看全局（dept_key IS NULL）+ 本部门
    const rows = await kbQuery(
      actor.kind === "admin"
        ? sql`SELECT id, title, fileName, sizeBytes, status, failReason, uploadedBy, createdAt, dept_key,
                visibility, usedCount,
                CHAR_LENGTH(textContent) AS parsedChars,
                LEFT(textContent, 200) AS excerpt
              FROM st_kb_docs ORDER BY id DESC LIMIT 200`
        : sql`SELECT id, title, fileName, sizeBytes, status, failReason, uploadedBy, createdAt, dept_key,
                visibility, usedCount,
                CHAR_LENGTH(textContent) AS parsedChars,
                LEFT(textContent, 200) AS excerpt
              FROM st_kb_docs
              WHERE dept_key IS NULL OR dept_key = ${actor.deptKey}
              ORDER BY id DESC LIMIT 200`,
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        title: String(r.title),
        fileName: String(r.fileName),
        sizeBytes: Number(r.sizeBytes ?? 0),
        status: String(r.status),
        failReason: r.failReason == null ? null : String(r.failReason),
        parsedChars: Number(r.parsedChars ?? 0),
        // 迭代 38：展示层敏感掩码
        excerpt: r.excerpt == null ? "" : maskSensitive(String(r.excerpt)),
        uploadedBy: String(r.uploadedBy ?? "admin"),
        deptKey: r.dept_key == null ? null : String(r.dept_key),
        visibility: String(r.visibility ?? "dept"),
        usedCount: Number(r.usedCount ?? 0),
        createdAt: r.createdAt,
      })),
    };
  }),

  /** 迭代 38：资料检索（供派活附带/Agent 上下文）；作用域同 list，摘要掩码 */
  docSearch: publicQuery
    .input(tokenInput.extend({ query: z.string().trim().max(120).optional() }))
    .query(async ({ input }) => {
      const actor = await kbActor(input.token);
      const kw = input.query?.trim() ?? "";
      const scopeSql =
        actor.kind === "admin"
          ? sql`1=1`
          : sql`(dept_key IS NULL OR dept_key = ${actor.deptKey})`;
      const rows = await kbQuery(
        sql`SELECT id, title, fileName, sizeBytes, dept_key, usedCount,
              CHAR_LENGTH(textContent) AS parsedChars,
              LEFT(textContent, 300) AS excerpt
            FROM st_kb_docs
            WHERE ${scopeSql} AND status = 'ready'
              AND (${kw} = '' OR title LIKE ${"%" + kw + "%"} OR textContent LIKE ${"%" + kw + "%"})
            ORDER BY id DESC LIMIT 50`,
      );
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          title: String(r.title),
          fileName: String(r.fileName),
          sizeBytes: Number(r.sizeBytes ?? 0),
          deptKey: r.dept_key == null ? null : String(r.dept_key),
          usedCount: Number(r.usedCount ?? 0),
          parsedChars: Number(r.parsedChars ?? 0),
          excerpt: r.excerpt == null ? "" : maskSensitive(String(r.excerpt)),
        })),
      };
    }),

  /** 迭代 38：资料确权卡——谁引用了这份文档（作用域校验同 list） */
  docRefs: publicQuery
    .input(tokenInput.extend({ docId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const actor = await kbActor(input.token);
      const docs = await kbQuery(sql`SELECT id, dept_key FROM st_kb_docs WHERE id = ${input.docId} LIMIT 1`);
      const doc = docs[0];
      if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "文档不存在" });
      if (actor.kind === "staff" && doc.dept_key != null && String(doc.dept_key) !== actor.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅可查看本部门资料的引用记录" });
      }
      const rows = await kbQuery(
        sql`SELECT id, usedBy, refId, agentSeatId, actor, createdAt FROM st_dept_doc_refs
            WHERE docId = ${input.docId} ORDER BY id DESC LIMIT 100`,
      );
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          usedBy: String(r.usedBy),
          refId: String(r.refId),
          agentSeatId: r.agentSeatId == null ? null : Number(r.agentSeatId),
          actor: String(r.actor ?? ""),
          createdAt: r.createdAt,
        })),
      };
    }),

  /** 物理删除文档行 */
  remove: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await kbActor(input.token);
      // 迭代 28：staff 仅部门负责人可删，且仅本部门文档
      if (actor.kind === "staff" && actor.role !== "head") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅部门负责人可删除知识库文档" });
      }
      const rows = await kbQuery(
        sql`SELECT id, dept_key FROM st_kb_docs WHERE id = ${input.id} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "文档不存在或已删除" });
      if (actor.kind === "staff" && String(rows[0].dept_key ?? "") !== actor.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅可删除本部门的知识库文档" });
      }
      await getDb().execute(sql`DELETE FROM st_kb_docs WHERE id = ${input.id}`);
      return { ok: true as const, id: input.id };
    }),

  /**
   * @deprecated 2026-08-13 死端点处置类五：HTTP 面零引用（内部走 loadKbContext 函数直调）。
   * 观察期 30 天，到期删除；需要知识库上下文请用内部函数，勿调本端点。
   */
  context: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const text = await loadKbContext(6000);
    return markDeprecated("kb.context", "loadKbContext(内部函数)", { text, chars: text.length });
  }),
});
