/** 下载通道管理：真实 APK 才能发布；版本/URL 一致；缺失配置可显式引导；双写带清理与补偿回滚。 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { withNamedDbConnection } from "../lib/dbLock";
import { withReleaseFileLock } from "../lib/releaseFileLock";
import { requireAdmin } from "../auth/adminGate";
import { requireDualSign } from "../auth/adminDualSign";
import { guardInfra } from "../auth/identity";
import { writeAdminAuditResult } from "./adminAnalytics";

import { PORTAL_PUBLIC, PORTAL_DIST_PUBLIC, DESKTOP_EXE, DESKTOP_FILE, DOWNLOAD_BASE, RELEASE_JSON, RELEASE_MANIFEST_HISTORY_DIR } from "../lib/releaseConfig";

const tokenInput = z.object({ token: z.string().trim().min(1) });
const reviewTokenInput = z.object({ reviewToken: z.string().trim().min(1) });


const RELEASE_API_SNAPSHOT_JSON = `api-${RELEASE_JSON}`;
const RELEASE_API_SNAPSHOT_SHA = 'api-SHA256SUMS';
const RELEASE_API_SNAPSHOT_HASHES = 'api-snapshot-hashes.tsv';

interface ReleaseJson { version: string; minVersion: string; url: string; leanUrl?: string; notes: string }
type ReleaseLockMetadata = { lockCleanupUnknown?: boolean; warning?: string }
type ReleaseMutationResult<T extends object> = Omit<T, keyof ReleaseLockMetadata> & {
  ok: true;
  auditWritten: boolean;
  auditOutcome: 'written' | 'failed' | 'timeout';
  warning: string | null;
  lockCleanupUnknown?: boolean;
}

function validRelease(d: unknown): d is ReleaseJson {
  const x = d as Partial<ReleaseJson>;
  return typeof x?.version === "string" && /^\d+\.\d+\.\d+$/.test(x.version)
    && typeof x.minVersion === "string" && /^\d+\.\d+\.\d+$/.test(x.minVersion)
    && typeof x.url === "string" && typeof x.notes === "string";
}

function readRelease(): ReleaseJson | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(PORTAL_PUBLIC, RELEASE_JSON), "utf-8"));
    if (!validRelease(parsed)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "app-release.json 形态无效——请修复后再发布，绝不覆盖损坏配置" });
    return parsed;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

function readReleaseSnapshotFile(file: string, version: string): ReleaseJson | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!validRelease(parsed) || parsed.version !== version || !isReleaseUrlForVersion(parsed.url, version)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `历史快照与目标版本或下载链不一致：${version}` });
    }
    return parsed;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

function readReleaseSnapshot(version: string): ReleaseJson | null {
  const dir = path.join(RELEASE_MANIFEST_HISTORY_DIR, version);
  // 新写入与恢复脚本分名；旧 API 快照及恢复脚本快照仅作只读兼容。
  return readReleaseSnapshotFile(path.join(dir, RELEASE_API_SNAPSHOT_JSON), version)
    ?? readReleaseSnapshotFile(path.join(dir, RELEASE_JSON), version);
}

function archiveReleaseSnapshot(current: ReleaseJson): void {
  if (current.version === "0.0.0") return;
  const dir = path.join(RELEASE_MANIFEST_HISTORY_DIR, current.version);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const body = JSON.stringify(current, null, 2) + "\n";
  const target = path.join(dir, RELEASE_API_SNAPSHOT_JSON);
  try {
    const previous = fs.readFileSync(target, "utf-8");
    const parsed: unknown = JSON.parse(previous);
    // 回滚会合法改变 notes/minVersion；首份快照只钉版本与下载文件身份，不阻断后续发布。
    if (!validRelease(parsed) || parsed.version !== current.version || !isReleaseUrlForVersion(parsed.url, current.version) || !isReleaseUrlForVersion(current.url, current.version)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `历史快照同版身份冲突，拒绝覆盖：${current.version}` });
    }
    return;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const nonce = `${process.pid}-${Date.now()}`;
  const writeAtomic = (file: string, content: string) => {
    const temp = `${file}.tmp-${nonce}`;
    try {
      fs.writeFileSync(temp, content, "utf-8");
      syncReleaseFile(temp);
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  };
  const digest = createHash("sha256").update(body).digest("hex");
  writeAtomic(target, body);
  writeAtomic(path.join(dir, RELEASE_API_SNAPSHOT_SHA), `${digest}  ${RELEASE_API_SNAPSHOT_JSON}\n`);
  writeAtomic(path.join(dir, RELEASE_API_SNAPSHOT_HASHES), `version\tsnapshot_sha256\n${current.version}\t${digest}\n`);
}

function isReleaseUrlForVersion(url: string, version: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(apkUrl(version));
    return parsed.protocol === expected.protocol && parsed.pathname === expected.pathname;
  } catch { return false; }
}

function compareSemver(a: string, b: string): number {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}

function apkFile(version: string): string { return `numx-max-v${version}.apk`; }
function apkUrl(version: string): string { return `${DOWNLOAD_BASE}/${apkFile(version)}`; }
function fileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); }
  catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return false;
    throw e;
  }
}
function requireApkBoth(version: string, notFound = false): void {
  const file = apkFile(version);
  if (!fileExists(path.join(PORTAL_PUBLIC, file)) || !fileExists(path.join(PORTAL_DIST_PUBLIC, file))) {
    throw new TRPCError({ code: notFound ? "NOT_FOUND" : "BAD_REQUEST", message: notFound ? "历史包不存在或未双份落盘——先核 history 再回滚" : "本版 APK 未落盘（public 与 dist/public 未双份齐备）——先同步包体再发布" });
  }
}
function optionalRead(file: string): string | null {
  try { return fs.readFileSync(file, "utf-8"); }
  catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null; // 仅“原本无文件”可补偿删除；读失败必须保留原档并中止
    throw e;
  }
}

function syncReleaseFile(file: string): void {
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeRelease(d: ReleaseJson): void {
  const targets = [path.join(PORTAL_PUBLIC, RELEASE_JSON), path.join(PORTAL_DIST_PUBLIC, RELEASE_JSON)];
  for (const dir of [PORTAL_PUBLIC, PORTAL_DIST_PUBLIC]) {
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error("not-directory");
    } catch {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `下载通道目录未就绪：${dir}——先构建门户并核目录权限` });
    }
  }
  const nonce = `${process.pid}-${Date.now()}`;
  const temps = targets.map((target) => `${target}.tmp-${nonce}`);
  const backups = targets.map(optionalRead);
  const body = JSON.stringify(d, null, 2) + "\n";
  const cleanup = () => { for (const tmp of temps) fs.rmSync(tmp, { force: true }); };
  try {
    fs.writeFileSync(temps[0], body, "utf-8");
    fs.writeFileSync(temps[1], body, "utf-8");
    syncReleaseFile(temps[0]);
    syncReleaseFile(temps[1]);
    fs.renameSync(temps[0], targets[0]);
    try {
      fs.renameSync(temps[1], targets[1]);
    } catch (e) {
      try {
        if (backups[0] === null) fs.rmSync(targets[0], { force: true });
        else {
          const recovery = `${targets[0]}.recovery-${nonce}`;
          fs.writeFileSync(recovery, backups[0], "utf-8");
          syncReleaseFile(recovery);
          fs.renameSync(recovery, targets[0]);
        }
      } catch (recoveryError) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `下载通道双写失败且补偿失败——public 与 dist/public 已分叉，请人工对齐（${String((recoveryError as { code?: string })?.code ?? "UNKNOWN")}）` });
      }
      throw e;
    }
  } finally {
    cleanup();
  }
}

const RELEASE_LOCK_NAME = "admin-release:app-release-json";
function withReleaseLock<T>(fn: () => Promise<T>): Promise<T & ReleaseLockMetadata> {
  return withNamedDbConnection(RELEASE_LOCK_NAME, () => withReleaseFileLock(fn), {
    busyMessage: "另一发布/回滚正在执行——请稍后重试",
    unavailableMessage: "发布锁暂不可用——稍后重试",
  });
}

function exeInfo(): { mtime: string; sizeBytes: number } | null {
  try {
    const st = fs.statSync(DESKTOP_EXE);
    return { mtime: st.mtime.toISOString(), sizeBytes: st.size };
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

export const adminReleaseRouter = createRouter({
  current: publicQuery.input(tokenInput).query(async ({ input }) => {
    return guardInfra("adminRelease.current", async () => {
      await requireAdmin(input.token);
      const d = readRelease();
      const exe = exeInfo();
      return { initialized: d !== null, app: d, desktop: exe ? { file: DESKTOP_FILE, ...exe } : null };
    });
  }),

  history: publicQuery.input(tokenInput).query(async ({ input }) => {
    return guardInfra("adminRelease.history", async () => {
      await requireAdmin(input.token);
      const currentRelease = readRelease();
      let files: string[];
      try {
        files = fs.readdirSync(PORTAL_PUBLIC)
          .filter((f) => /^numx-max-v\d+\.\d+\.\d+\.apk$/.test(f))
          .sort((a, b) => compareSemver(b.replace(/^numx-max-v|\.apk$/g, ""), a.replace(/^numx-max-v|\.apk$/g, "")));
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return { items: [], current: currentRelease?.version ?? null, initialized: currentRelease !== null };
        throw e;
      }
      return {
        items: files.flatMap((f) => {
          try {
            const st = fs.statSync(path.join(PORTAL_PUBLIC, f));
            const synced = fileExists(path.join(PORTAL_DIST_PUBLIC, f));
            return [{ file: f, sizeBytes: st.size, mtime: st.mtime.toISOString(), synced }];
          } catch (e) {
            if ((e as { code?: string }).code === "ENOENT") return []; // 列目录后被清理=跳过，不拖垮整页
            throw e;
          }
        }),
        current: currentRelease?.version ?? null,
        initialized: currentRelease !== null,
      };
    });
  }),

  publish: publicQuery
    .input(tokenInput.extend({
      version: z.string().trim().regex(/^\d+\.\d+\.\d+$/, "版本号须 x.y.z"),
      url: z.string().trim().min(1).max(300),
      notes: z.string().trim().min(1).max(2000),
      ...reviewTokenInput.shape,
    }))
    .mutation(async ({ input }) => {
      return guardInfra("adminRelease.publish", async () => {
        const sign = await requireDualSign(input.token, input.reviewToken, "release");
        const published = await withReleaseLock(async () => {
          // 锁内重读基线：另一实例先发布后，本请求必须按新版本重新判递进，不能覆盖旧读快照。
          const existing = readRelease();
          if (compareSemver(input.version, existing?.version ?? "0.0.0") <= 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `版本须递进（当前 ${existing?.version ?? "未初始化"}）——回滚走 rollback 专用面` });
          }
          const expectedFile = apkFile(input.version);
          if (![expectedFile, apkUrl(input.version)].includes(input.url)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `下载链须与版本一致：${expectedFile} 或 ${apkUrl(input.version)}` });
          }
          requireApkBoth(input.version);
          const base: ReleaseJson = existing ?? { version: "0.0.0", minVersion: input.version, url: "", notes: "" };
          if (existing) archiveReleaseSnapshot(existing);
          writeRelease({ ...base, minVersion: input.version, version: input.version, url: apkUrl(input.version), notes: input.notes });
          return { version: input.version, url: apkUrl(input.version) };
        });
        const auditOutcome = await writeAdminAuditResult(sign.operatorId, sign.operator, "adminRelease.publish", `v${input.version}`, { url: apkUrl(input.version), operator: sign.operator, reviewer: sign.reviewer, reviewerId: sign.reviewerId });
        const lockWarning = published.lockCleanupUnknown ? published.warning : null
        let auditNotice: string | null = null
        if (auditOutcome === "timeout") auditNotice = "审计结果未知（写入超时），请人工核查，禁止盲目重试"
        else if (auditOutcome !== "written") auditNotice = "发布已完成，审计写入失败；请人工核查，禁止盲目重试"
        return Object.assign({}, published, {
          ok: true as const,
          auditWritten: auditOutcome === "written",
          auditOutcome,
          warning: [lockWarning, auditNotice].filter((value): value is string => Boolean(value)).join('；') || null,
          lockCleanupUnknown: published.lockCleanupUnknown,
        }) satisfies ReleaseMutationResult<typeof published>;
      });
    }),

  rollback: publicQuery
    .input(tokenInput.extend({ version: z.string().trim().regex(/^\d+\.\d+\.\d+$/), ...reviewTokenInput.shape }))
    .mutation(async ({ input }) => {
      return guardInfra("adminRelease.rollback", async () => {
        const sign = await requireDualSign(input.token, input.reviewToken, "release");
        const rolledBack = await withReleaseLock(async () => {
          const existing = readRelease();
          if (compareSemver(input.version, existing?.version ?? "0.0.0") >= 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "回滚目标须低于当前版本；同版重放或更高版本请走 publish 递进闸" });
          }
          requireApkBoth(input.version, true);
          const snapshot = readReleaseSnapshot(input.version);
          const base: ReleaseJson = snapshot ?? existing ?? { version: "0.0.0", minVersion: input.version, url: "", notes: "" };
          const minVersion = compareSemver(input.version, base.minVersion) < 0 ? input.version : base.minVersion;
          writeRelease({ ...base, leanUrl: existing?.leanUrl ?? base.leanUrl, minVersion, version: input.version, url: apkUrl(input.version), notes: `回滚至 v${input.version}（原 ${existing?.version ?? "未初始化"}）` });
          return { version: input.version, url: apkUrl(input.version), fromVersion: existing?.version ?? null, snapshotVerified: snapshot !== null };
        });
        const auditOutcome = await writeAdminAuditResult(sign.operatorId, sign.operator, "adminRelease.rollback", `v${input.version}`, { from: rolledBack.fromVersion, operator: sign.operator, reviewer: sign.reviewer, reviewerId: sign.reviewerId });
        const lockWarning = rolledBack.lockCleanupUnknown ? rolledBack.warning : null
        let auditNotice: string | null = null
        if (auditOutcome === "timeout") auditNotice = "审计结果未知（写入超时），请人工核查，禁止盲目重试"
        else if (auditOutcome !== "written") auditNotice = "回滚已完成，审计写入失败；请人工核查，禁止盲目重试"
        return Object.assign({}, rolledBack, {
          ok: true as const,
          auditWritten: auditOutcome === "written",
          auditOutcome,
          warning: [lockWarning, auditNotice].filter((value): value is string => Boolean(value)).join('；') || null,
          lockCleanupUnknown: rolledBack.lockCleanupUnknown,
        }) satisfies ReleaseMutationResult<typeof rolledBack>;
      });
    }),
});
