/**
 * M31 工作台附件中心验收单测：
 * 1. upload：png 图片可传（落盘+台账+返回 id/kind/size）；
 * 2. 类型白名单：exe/js/svg 一律拒（mime 黑名单 + 扩展名伪装双闸）；
 * 3. 大小闸：>8MB 拒；空文件拒；
 * 4. list 企业隔离：只见本企业附件（他企业 id → download/remove 404）；
 * 5. download：本企业可取（base64 回传，内容与上传一致）；
 * 6. remove：上传者本人/admin 可删，第三人 FORBIDDEN。
 *
 * 落盘到测试临时目录（ST_UPLOAD_DIR 注入）；DB 经 getDb/stQuery mock（状态ful 假表）。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRPCError } from "@trpc/server";

const TMP_DIR = path.join(os.tmpdir(), `wbfiles-test-${process.pid}`);
process.env.ST_UPLOAD_DIR = TMP_DIR;

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token === "TEST_a") return { user: { id: 7, username: "alice", displayName: "阿丽", role: "member" }, factory: { id: 10 } };
    if (token === "TEST_b") return { user: { id: 8, username: "bob", displayName: "阿波", role: "member" }, factory: { id: 10 } };
    if (token === "TEST_admin") return { user: { id: 1, username: "boss", displayName: "老板", role: "admin" }, factory: { id: 10 } };
    if (token === "TEST_other") return { user: { id: 99, username: "other", displayName: "外人", role: "member" }, factory: { id: 20 } };
    throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
  },
  normalizeRole: (role: string) => (role === "admin" || role === "owner" ? "admin" : role === "manager" ? "manager" : "staff"),
}));

interface FileFake {
  id: number;
  factoryId: number;
  uploaderId: number;
  title: string;
  fileName: string;
  mimeType: string;
  kind: string;
  filePath: string;
  sizeBytes: number;
  createdAt: Date;
}
let files: FileFake[];
let seq: number;

function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join("") : String(v ?? "");
    })
    .join("");
}
function sqlParamsOf(q: unknown): unknown[] {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: unknown[] = [];
  for (const c of chunks) {
    const isText = (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk";
    if (isText) continue;
    const rec = c as { value?: unknown };
    out.push(rec && typeof rec === "object" && "value" in rec ? rec.value : c);
  }
  return out;
}

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      const p = sqlParamsOf(q);
      if (/INSERT INTO st_attachments/.test(t)) {
        const id = seq++;
        files.push({
          id,
          factoryId: Number(p[0]),
          uploaderId: Number(p[1]),
          title: String(p[2]),
          fileName: String(p[3]),
          mimeType: String(p[4]),
          kind: String(p[5]),
          filePath: String(p[6]),
          sizeBytes: Number(p[7]),
          createdAt: new Date(),
        });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/DELETE FROM st_attachments/.test(t)) {
        const before = files.length;
        files = files.filter((f) => !(f.id === Number(p[0]) && f.factoryId === Number(p[1])));
        return [{ affectedRows: before - files.length }];
      }
      return [[]];
    },
  }),
}));

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    stQuery: async (q: unknown) => {
      const t = sqlTextOf(q);
      const p = sqlParamsOf(q);
      if (/FROM st_attachments WHERE id/.test(t)) {
        const f = files.find((x) => x.id === Number(p[0]) && x.factoryId === Number(p[1]));
        return f ? [{ ...f }] : [];
      }
      if (/FROM st_attachments a LEFT JOIN wb_users/.test(t)) {
        return files
          .filter((f) => f.factoryId === Number(p[0]))
          .sort((a, b) => b.id - a.id)
          .map((f) => ({ ...f, uploaderName: f.uploaderId === 7 ? "阿丽" : f.uploaderId === 8 ? "阿波" : "老板" }));
      }
      return [];
    },
  };
});

import { wbFilesRouter, validateUpload } from "./routers/wbFiles";

const caller = wbFilesRouter.createCaller({} as never);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(() => {
  files = [];
  seq = 1;
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe("M31 附件中心", () => {
  it("validateUpload：图片/办公/文本放行；脚本/可执行/伪装一律拒", () => {
    expect(validateUpload("image/png", "a.png", 100)).toBe("image");
    expect(validateUpload("application/pdf", "b.pdf", 100)).toBe("office");
    expect(validateUpload("text/csv", "c.csv", 100)).toBe("text");
    expect(() => validateUpload("application/x-msdownload", "e.exe", 100)).toThrow(/只支持/);
    expect(() => validateUpload("image/png", "evil.exe", 100)).toThrow(/不一致/);
    expect(() => validateUpload("image/svg+xml", "s.svg", 100)).toThrow(/只支持/);
    expect(() => validateUpload("image/png", "big.png", 9 * 1024 * 1024)).toThrow(/8MB/);
    expect(() => validateUpload("image/png", "empty.png", 0)).toThrow(/空文件/);
  });

  it("upload→list→download 全链：落盘真实可读，内容一致，企业隔离", async () => {
    const up = await caller.upload({
      token: "TEST_a",
      fileName: "现场照片.png",
      mimeType: "image/png",
      fileBase64: PNG_BYTES.toString("base64"),
    });
    expect(up.ok).toBe(true);
    expect(up.kind).toBe("image");
    expect(up.sizeBytes).toBe(PNG_BYTES.length);

    const list = await caller.list({ token: "TEST_b" });
    expect(list.files).toHaveLength(1);
    expect(list.files[0]!.uploaderName).toBe("阿丽");

    const dl = await caller.download({ token: "TEST_b", id: up.id });
    expect(Buffer.from(dl.base64, "base64").equals(PNG_BYTES)).toBe(true);
    expect(dl.fileName).toBe("现场照片.png");

    // 他企业：list 空 + download/remove 404
    expect((await caller.list({ token: "TEST_other" })).files).toHaveLength(0);
    await expect(caller.download({ token: "TEST_other", id: up.id })).rejects.toThrow(/不存在/);
    await expect(caller.remove({ token: "TEST_other", id: up.id })).rejects.toThrow(/不存在/);
  });

  it("remove：上传者本人可删；第三人 FORBIDDEN；admin 可删", async () => {
    const up = await caller.upload({
      token: "TEST_a",
      fileName: "报表.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileBase64: PNG_BYTES.toString("base64"),
    });
    await expect(caller.remove({ token: "TEST_b", id: up.id })).rejects.toThrow(/上传者本人或管理员/);
    expect((await caller.remove({ token: "TEST_a", id: up.id })).ok).toBe(true);
    await expect(caller.download({ token: "TEST_a", id: up.id })).rejects.toThrow(/不存在/);

    const up2 = await caller.upload({
      token: "TEST_b",
      fileName: "说明.txt",
      mimeType: "text/plain",
      fileBase64: Buffer.from("hello").toString("base64"),
    });
    expect((await caller.remove({ token: "TEST_admin", id: up2.id })).ok).toBe(true);
  });
});
