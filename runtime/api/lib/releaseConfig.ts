import path from "node:path";

function envOr(name: string, fallback: string): string { return (process.env[name] ?? "").trim() || fallback; }

export const PORTAL_PUBLIC = envOr("PORTAL_PUBLIC_DIR", path.resolve(process.cwd(), "public"));
export const PORTAL_DIST_PUBLIC = envOr("PORTAL_DIST_PUBLIC_DIR", path.resolve(process.cwd(), "dist/public"));
export const DESKTOP_EXE = envOr("DESKTOP_ORG_EXE", path.resolve(process.cwd(), "desktop/dl/numx-org-runtime-setup.exe"));
export const DESKTOP_FILE = path.basename(DESKTOP_EXE);
export const DOWNLOAD_BASE = envOr("PORTAL_DOWNLOAD_BASE_URL", "https://downloads.example.invalid").replace(/\/+$/, "");
export const RELEASE_JSON = "app-release.json";
export const RELEASE_MANIFEST_HISTORY_DIR = envOr("RELEASE_MANIFEST_HISTORY_DIR", path.resolve(process.cwd(), "release-work/manifest-history"));
