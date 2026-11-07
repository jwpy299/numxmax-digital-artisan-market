import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(__dirname, "sync-release-artifacts.sh");
const roots: string[] = [];
const desktopFiles = ["dl/numx-personal-setup.exe", "dl/numx-enterprise-setup.exe", "dl/numx-org-runtime-setup.exe"];
function metadata(version: string) {
  const apk = `numx-max-v${version}.apk`;
  const leanApk = `lingshu-spirit-lean-v${version}.apk`;
  return JSON.stringify({ version, minVersion: version, url: `https://example.test/${apk}`, leanUrl: `https://example.test/${leanApk}`, notes: `v${version} 恢复测试` });
}
function checksums(src: string, files: string[]) {
  const lines = files.map((file) => `${createHash("sha256").update(fs.readFileSync(path.join(src, file))).digest("hex")}  ./${file}\r`);
  fs.writeFileSync(path.join(src, "SHA256SUMS"), `${lines.join("\n")}\n`);
}
function fixture(version = "2.9.66") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-restore-test-"));
  roots.push(root);
  const src = path.join(root, "backup");
  const dst = path.join(root, "public");
  const dist = path.join(root, "dist-public");
  for (const dir of [src, dst, dist]) fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(src, 0o700);
  const apk = `numx-max-v${version}.apk`;
  const leanApk = `lingshu-spirit-lean-v${version}.apk`;
  const payload = [apk, leanApk, ...desktopFiles, "gh_icon.png"];
  fs.writeFileSync(path.join(src, "app-release.json"), metadata(version));
  fs.writeFileSync(path.join(src, apk), `verified-apk-${version}`);
  fs.writeFileSync(path.join(src, leanApk), `verified-lean-${version}`);
  for (const file of desktopFiles) {
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    fs.writeFileSync(path.join(src, file), `desktop-${file}`);
  }
  fs.writeFileSync(path.join(src, "gh_icon.png"), "icon");
  checksums(src, payload);
  return { root, src, dst, dist, apk, payload };
}
function runRestore(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
    env: { ...process.env, RELEASE_BACKUP_DIR: f.src, PORTAL_PUBLIC_DIR: f.dst, PORTAL_DIST_PUBLIC_DIR: f.dist, RELEASE_LOCK_FILE: path.join(f.root, "restore.lock"), RELEASE_WORK_ROOT: path.join(f.root, "work"), RELEASE_PUBLIC_BASE_URL: "https://example.test", ...extra },
    encoding: "utf8",
  });
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const HAS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(!HAS_ROOT)("发布制品恢复（root-only；公开 CI 另有特权复跑）", () => {
  it("全部哈希验讫后双目录恢复，清单最后生效且权限正确", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dst, "app-release.json"), metadata("2.9.65"));
    fs.writeFileSync(path.join(f.src, "numx-max-v0.0.1.apk"), "verified-old-apk");
    f.payload.push("numx-max-v0.0.1.apk");
    checksums(f.src, f.payload);
    const result = runRestore(f);
    expect(result.status, result.stderr).toBe(0);
    for (const target of [f.dst, f.dist]) {
      expect(fs.readFileSync(path.join(target, f.apk), "utf8")).toBe("verified-apk-2.9.66");
      expect(fs.readFileSync(path.join(target, "lingshu-spirit-lean-v2.9.66.apk"), "utf8")).toBe("verified-lean-2.9.66");
      expect(JSON.parse(fs.readFileSync(path.join(target, "app-release.json"), "utf8")).version).toBe("2.9.66");
      for (const file of desktopFiles) expect(fs.existsSync(path.join(target, file))).toBe(true);
      expect(fs.statSync(path.join(target, f.apk)).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(path.join(target, "numx-max-v0.0.1.apk"), "utf8")).toBe("verified-old-apk");
      expect(fs.readdirSync(target).some((name) => name.startsWith(".release-staging-") || name.startsWith(".release-rollback-"))).toBe(false);
    }
    const history = path.join(f.root, "work", "manifest-history", "2.9.66");
    expect(fs.readFileSync(path.join(history, "app-release.json"), "utf8")).toBe(metadata("2.9.66"));
    expect(fs.readFileSync(path.join(history, "SHA256SUMS"), "utf8")).toBe(fs.readFileSync(path.join(f.src, "SHA256SUMS"), "utf8"));
    expect(fs.readFileSync(path.join(history, "snapshot-hashes.tsv"), "utf8")).toContain(f.apk);
  });

  it("API 专用历史目录不冒充脚本快照，自定义 HISTORY_ROOT 且原文件不被覆盖", () => {
    const f = fixture();
    const historyRoot = path.join(f.root, "custom-history");
    const history = path.join(historyRoot, "2.9.66");
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    fs.chmodSync(history, 0o700);
    fs.writeFileSync(path.join(history, "api-app-release.json"), metadata("2.9.66"));
    fs.writeFileSync(path.join(history, "api-SHA256SUMS"), "api-owned\n");
    const result = runRestore(f, { RELEASE_MANIFEST_HISTORY_DIR: historyRoot });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(history, "api-SHA256SUMS"), "utf8")).toBe("api-owned\n");
    expect(fs.readFileSync(path.join(history, "app-release.json"), "utf8")).toBe(metadata("2.9.66"));
    expect(fs.readFileSync(path.join(history, "SHA256SUMS"), "utf8")).toBe(fs.readFileSync(path.join(f.src, "SHA256SUMS"), "utf8"));
    expect(fs.existsSync(path.join(history, "snapshot-hashes.tsv"))).toBe(true);
  });

  it("坏 APK 不覆盖现有两个下载目录", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.src, "SHA256SUMS"), `${"0".repeat(64)}  ${f.apk}\n`);
    for (const target of [f.dst, f.dist]) {
      fs.writeFileSync(path.join(target, "app-release.json"), metadata("2.9.65"));
      fs.writeFileSync(path.join(target, "numx-max-v2.9.65.apk"), "known-good");
    }
    const result = runRestore(f);
    expect(result.status).not.toBe(0);
    for (const target of [f.dst, f.dist]) {
      expect(fs.readFileSync(path.join(target, "numx-max-v2.9.65.apk"), "utf8")).toBe("known-good");
      expect(fs.existsSync(path.join(target, f.apk))).toBe(false);
    }
  });

  it("桌面 EXE 哈希异常同样拒绝发布", () => {
    const f = fixture();
    const lines = fs.readFileSync(path.join(f.src, "SHA256SUMS"), "utf8").split(/\r?\n/).filter(Boolean);
    lines[1] = `${"0".repeat(64)}  ./${desktopFiles[0]}`;
    fs.writeFileSync(path.join(f.src, "SHA256SUMS"), lines.join("\n"));
    const result = runRestore(f);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(f.dst, f.apk))).toBe(false);
    expect(fs.existsSync(path.join(f.dist, f.apk))).toBe(false);
  });

  it("历史包缺少哈希时不允许进入白名单", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.src, "numx-max-v0.0.1.apk"), "unverified-old-apk");
    const result = runRestore(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SHA256SUMS 缺少 numx-max-v0.0.1.apk");
    expect(fs.existsSync(path.join(f.dst, "numx-max-v0.0.1.apk"))).toBe(false);
  });

  it("发布后失败按快照回滚并清理恢复证据", () => {
    const f = fixture();
    for (const target of [f.dst, f.dist]) {
      fs.writeFileSync(path.join(target, "app-release.json"), metadata("2.9.65"));
      fs.writeFileSync(path.join(target, "numx-max-v2.9.65.apk"), "known-good");
    }
    const result = runRestore(f, { RELEASE_TEST_FAIL_AFTER_PAYLOAD: "1", RELEASE_TEST_MODE: "1" });
    expect(result.status).not.toBe(0);
    for (const target of [f.dst, f.dist]) {
      expect(fs.readFileSync(path.join(target, "numx-max-v2.9.65.apk"), "utf8")).toBe("known-good");
      expect(JSON.parse(fs.readFileSync(path.join(target, "app-release.json"), "utf8")).version).toBe("2.9.65");
      expect(fs.existsSync(path.join(target, f.apk))).toBe(false);
    }
    const work = path.join(f.root, "work");
    expect(fs.readdirSync(work).some((name) => name.startsWith("rollback-") || name.startsWith("staging-"))).toBe(false);
  });

  it("首个清单发布后失败会恢复两个目录的旧清单与制品", () => {
    const f = fixture();
    for (const target of [f.dst, f.dist]) {
      fs.writeFileSync(path.join(target, "app-release.json"), metadata("2.9.65"));
      fs.writeFileSync(path.join(target, "numx-max-v2.9.65.apk"), "known-good");
    }
    const result = runRestore(f, { RELEASE_TEST_FAIL_AFTER_FIRST_MANIFEST: "1", RELEASE_TEST_MODE: "1" });
    expect(result.status, result.stderr).not.toBe(0);
    for (const target of [f.dst, f.dist]) {
      expect(JSON.parse(fs.readFileSync(path.join(target, "app-release.json"), "utf8")).version).toBe("2.9.65");
      expect(fs.readFileSync(path.join(target, "numx-max-v2.9.65.apk"), "utf8")).toBe("known-good");
      expect(fs.existsSync(path.join(target, f.apk))).toBe(false);
    }
  });

  it("旧清单不存在时，首个清单发布后的回滚会删除新清单", () => {
    const f = fixture();
    for (const target of [f.dst, f.dist]) fs.writeFileSync(path.join(target, "numx-max-v2.9.65.apk"), "known-good");
    const result = runRestore(f, { RELEASE_TEST_FAIL_AFTER_FIRST_MANIFEST: "1", RELEASE_TEST_MODE: "1" });
    expect(result.status, result.stderr).not.toBe(0);
    for (const target of [f.dst, f.dist]) {
      expect(fs.existsSync(path.join(target, "app-release.json"))).toBe(false);
      expect(fs.readFileSync(path.join(target, "numx-max-v2.9.65.apk"), "utf8")).toBe("known-good");
      expect(fs.existsSync(path.join(target, f.apk))).toBe(false);
    }
  });

  it("故障注入没有显式测试模式时，在任何写入前拒绝", () => {
    const f = fixture();
    for (const target of [f.dst, f.dist]) {
      fs.writeFileSync(path.join(target, "app-release.json"), metadata("2.9.65"));
      fs.writeFileSync(path.join(target, "numx-max-v2.9.65.apk"), "known-good");
    }
    const result = runRestore(f, { RELEASE_TEST_FAIL_AFTER_PAYLOAD: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RELEASE_TEST_MODE=1");
    for (const target of [f.dst, f.dist]) {
      expect(JSON.parse(fs.readFileSync(path.join(target, "app-release.json"), "utf8")).version).toBe("2.9.65");
      expect(fs.existsSync(path.join(target, f.apk))).toBe(false);
    }
    expect(fs.existsSync(path.join(f.root, "work"))).toBe(false);
  });

  it("备份含更高版本主包时跳过且不阻塞恢复", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.src, "numx-max-v99.0.0.apk"), "not-yet-released");
    const result = runRestore(f);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("跳过高于当前恢复版本");
    for (const target of [f.dst, f.dist]) expect(fs.existsSync(path.join(target, "numx-max-v99.0.0.apk"))).toBe(false);
  });

  it("工作目录不得落在公网目录内", () => {
    const f = fixture();
    const result = runRestore(f, { RELEASE_WORK_ROOT: path.join(f.dst, "release-work") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("路径不得重合或嵌套");
  });

  it("故障注入路径先归一化，不能借 /tmp/.. 绕过", () => {
    const f = fixture();
    const result = runRestore(f, { RELEASE_TEST_MODE: "1", RELEASE_TEST_FAIL_AFTER_PAYLOAD: "1", RELEASE_WORK_ROOT: "/tmp/../opt/numxmax/release-work" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("故障注入只允许操作 /tmp");
  });

  it("清单键序变化时仍精确读取 version/url/leanUrl", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.src, "app-release.json"), JSON.stringify({ leanUrl: `https://example.test/lingshu-spirit-lean-v2.9.66.apk`, url: `https://example.test/${f.apk}`, notes: "键序回归", minVersion: "2.9.66", version: "2.9.66" }));
    const result = runRestore(f);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.dst, "app-release.json"), "utf8")).version).toBe("2.9.66");
  });

  it("备份含更高版本精简包时按独立版本链跳过", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.src, "lingshu-spirit-lean-v99.0.0.apk"), "not-yet-released-lean");
    const result = runRestore(f);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("跳过高于当前精简版本");
    for (const target of [f.dst, f.dist]) expect(fs.existsSync(path.join(target, "lingshu-spirit-lean-v99.0.0.apk"))).toBe(false);
  });

  it("已有公网目录权限不被恢复过程放宽", () => {
    const f = fixture();
    fs.chmodSync(f.dst, 0o750);
    fs.chmodSync(f.dist, 0o750);
    const result = runRestore(f);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(f.dst).mode & 0o777).toBe(0o750);
    expect(fs.statSync(f.dist).mode & 0o777).toBe(0o750);
  });

  it("邀请页主包有有效哈希时可恢复", () => {
    const f = fixture();
    const inviteApk = "lingshu-spirit-v2.9.56.apk";
    fs.writeFileSync(path.join(f.src, inviteApk), "verified-invite-apk");
    f.payload.push(inviteApk);
    checksums(f.src, f.payload);
    const result = runRestore(f);
    expect(result.status, result.stderr).toBe(0);
    for (const target of [f.dst, f.dist]) expect(fs.readFileSync(path.join(target, inviteApk), "utf8")).toBe("verified-invite-apk");
  });

  it("lean 渠道降级必须拒绝", () => {
    const f = fixture();
    for (const target of [f.dst, f.dist]) {
      fs.writeFileSync(path.join(target, "app-release.json"), metadata("2.9.65"));
      fs.writeFileSync(path.join(target, "numx-max-v2.9.65.apk"), "known-good");
      const current = JSON.parse(metadata("2.9.65"));
      current.leanUrl = "https://example.test/lingshu-spirit-lean-v99.0.0.apk";
      fs.writeFileSync(path.join(target, "app-release.json"), JSON.stringify(current));
    }
    const result = runRestore(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("拒绝用旧精简版本");
  });

  it("拒绝旧版本覆盖任一目录的当前清单", () => {
    const f = fixture("2.9.66");
    for (const target of [f.dst, f.dist]) fs.writeFileSync(path.join(target, "app-release.json"), metadata("2.9.67"));
    const result = runRestore(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("拒绝用旧版本");
    for (const target of [f.dst, f.dist]) expect(JSON.parse(fs.readFileSync(path.join(target, "app-release.json"), "utf8")).version).toBe("2.9.67");
  });

  it("缺桌面安装包时不允许假成功或部分发布", () => {
    const f = fixture();
    fs.rmSync(path.join(f.src, desktopFiles[0]));
    const result = runRestore(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("备份缺制品");
     expect(fs.existsSync(path.join(f.dst, f.apk))).toBe(false);
    expect(fs.existsSync(path.join(f.dst, f.apk))).toBe(false);
    expect(fs.existsSync(path.join(f.dist, f.apk))).toBe(false);
  });
}, 15000);
