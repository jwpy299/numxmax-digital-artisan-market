/**
 * releases —— Harness 交付装配线·发布观测板数据端（P0-③④）。
 *
 * 只读端点（本迭代不写操作）：
 * - 读本机制品仓库 <appRoot>/artifacts/releases/（版本化归档，保留近 10 版）；
 * - 读 dist/RELEASES.log 尾部（发布流水）；
 * - 算当前 live dist/boot.js 的 md5（与制品归档对照，验证"跑的就是发的"）；
 * - 回滚指引：回滚动作在本迭代保留为服务器 CLI（rollback.sh，30 秒级），
 *   面板只给出本机对应的命令文本，不在面板执行（权限面不扩大）。
 *
 * 安全：requireAdminToken 守门；只读文件系统；绝不读 .env/密钥；路径全部
 * 约束在 cwd 之内（readdir 结果逐一校验无 ..，防路径穿越）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
// M48d：发布观测板为超级终端专属（admin SPA 唯一消费方），随超终同口径走本厂闸
import { requireHqAdmin as requireAdminToken } from "./terminal";

const execFileP = promisify(execFile);

/** 单文件 md5（8 位短码，与 verifier 记录口径一致） */
async function md5Short(file: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(file);
    return createHash("md5").update(buf).digest("hex").slice(0, 8);
  } catch {
    return null;
  }
}

export interface ReleaseArtifact {
  name: string;
  bootMd5: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface ReleasesBoard {
  host: string;
  service: string;
  serviceActive: boolean;
  liveBootMd5: string | null;
  liveBootMtime: string | null;
  artifactsDir: string;
  artifacts: ReleaseArtifact[];
  log: string[];
  rollback: { command: string; note: string };
}

/** 防路径穿越：只接受 [A-Za-z0-9._-] 目录名 */
function safeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

async function readBoard(): Promise<ReleasesBoard> {
  const appRoot = process.cwd();
  const distDir = path.join(appRoot, "dist");
  const artifactsDir = path.join(appRoot, "artifacts", "releases");

  // live boot.js 状态
  const liveBoot = path.join(distDir, "boot.js");
  const liveBootMd5 = await md5Short(liveBoot);
  let liveBootMtime: string | null = null;
  try {
    const st = await fs.stat(liveBoot);
    liveBootMtime = st.mtime.toISOString();
  } catch {
    /* dist 缺失时按 null 降级 */
  }

  // 制品仓库清单（不存在 → 空表，面板提示未初始化）
  const artifacts: ReleaseArtifact[] = [];
  try {
    const names = (await fs.readdir(artifactsDir)).filter(safeName).sort().reverse().slice(0, 10);
    for (const name of names) {
      const bootPath = path.join(artifactsDir, name, "boot.js");
      const bootMd5 = await md5Short(bootPath);
      let sizeBytes = 0;
      let createdAt = "";
      try {
        const st = await fs.stat(bootPath);
        sizeBytes = st.size;
        createdAt = st.mtime.toISOString();
      } catch {
        /* 半成品归档：md5/size 置空，仍列出名字便于排查 */
      }
      artifacts.push({ name, bootMd5, sizeBytes, createdAt });
    }
  } catch {
    /* artifacts 目录未建 → 空清单 */
  }

  // RELEASES.log 尾部 20 行
  let log: string[] = [];
  try {
    const raw = await fs.readFile(path.join(distDir, "RELEASES.log"), "utf8");
    log = raw.trim().split("\n").filter(Boolean).slice(-20).reverse();
  } catch {
    /* 无日志 → 空 */
  }

  // 服务状态（systemctl is-active；非 systemd 环境 → false + 不抛错）
  let serviceActive = false;
  let service = "unknown";
  try {
    service = path.basename(appRoot) === "app" ? path.basename(path.dirname(appRoot)) : path.basename(appRoot);
    const { stdout } = await execFileP("systemctl", ["is-active", service], { timeout: 4000 });
    serviceActive = stdout.trim() === "active";
  } catch {
    /* 容器/无 systemd → false，不阻断面板 */
  }

  return {
    host: process.env.RELEASE_HOST_LABEL ?? service,
    service,
    serviceActive,
    liveBootMd5,
    liveBootMtime,
    artifactsDir,
    artifacts,
    log,
    rollback: {
      command: `sudo bash ${path.join(appRoot, "artifacts", "rollback.sh")} <版本名>`,
      note: "回滚保留为服务器 CLI（30 秒级）：恢复 boot.js+public 快照并重启服务；面板只读不执行。",
    },
  };
}

export const releasesRouter = createRouter({
  /** releases.board（query，管理员 token）：本机发布观测板（只读）。 */
  board: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdminToken(input.token);
      return readBoard();
    }),
});
