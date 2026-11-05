#!/usr/bin/env node
/** 按壳原子生成 generated/shellKey.cjs 与 generated/preload.cjs；npm start、直接打包与正式构建共用。 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const locked = args.includes("--locked");
const shell = args.find((arg) => !arg.startsWith("--")) || "personal";
const cfg = require(path.join(root, "src", "apiAllowlist.cjs"));
if (!Object.hasOwn(cfg.SHELL_API_BASE, shell)) throw new Error(`未知壳键: ${shell}`);
const allowed = cfg.SHELL_API_BASE[shell];
if (typeof allowed !== "string" || !allowed.startsWith("https://")) throw new Error(`非法壳/API 基址: ${shell}`);

function replaceToken(text, token, value) {
  return text.split(token).join(value);
}

function render() {
  const template = fs.readFileSync(path.join(root, "src", "preload.template.cjs"), "utf8");
  for (const token of ["__API_BASE_ALLOWLIST__", "__API_BASE_ARG__", "__NUMX_SHELL__"]) {
    if (!template.includes(token)) throw new Error(`preload template 占位缺失: ${token}`);
  }
  let out = replaceToken(template, "__API_BASE_ALLOWLIST__", JSON.stringify([allowed]));
  out = replaceToken(out, "__API_BASE_ARG__", JSON.stringify(cfg.API_BASE_ARG));
  out = replaceToken(out, "__NUMX_SHELL__", JSON.stringify(shell));
  if (/__(API_BASE_ALLOWLIST|API_BASE_ARG|NUMX_SHELL)__/.test(out)) throw new Error("preload 占位未完整渲染");

  const target = path.join(root, "src", "generated");
  const temp = fs.mkdtempSync(path.join(root, "src", ".generated-"));
  const backup = path.join(root, "src", `.generated-backup-${process.pid}`);
  try {
    fs.writeFileSync(path.join(temp, "shellKey.cjs"), `module.exports = ${JSON.stringify(shell)};\n`);
    fs.writeFileSync(path.join(temp, "preload.cjs"), out);
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(temp, target);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(backup)) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(backup, target);
    }
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`RENDER_OK shell=${shell} apiBase=${allowed}`);
}

function hasFlock() {
  try {
    const result = spawnSync("sh", ["-c", "command -v flock"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

if (locked) {
  render();
} else if (hasFlock()) {
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const lockDir = path.join(cacheRoot, "numx-desktop");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(lockDir, 0o700);
  const lockPath = path.join(lockDir, "build.lock");
  const command = [process.execPath, __filename, "--locked", shell].map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
  execFileSync("flock", ["-n", lockPath, "-c", command], { stdio: "inherit" });
} else {
  console.warn(`[render] 当前平台 ${process.platform} 无 flock，使用原子目录替换保证生成件一致；正式构建仍由脚本强制 flock`);
  render();
}
