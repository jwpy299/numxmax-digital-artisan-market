import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'plugin-inspect-react-code'

// Desktop Electron uses file://; web builds keep the existing absolute-root behavior.
const IS_DESKTOP = process.env.VITE_DESKTOP === '1'
if (!IS_DESKTOP && process.env.VITE_API_BASE) throw new Error('web build 不许设 VITE_API_BASE（桌面专用）')

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  if (command === "serve") process.env.NEBULA_VITE_DEV_SERVER = "1"
  return {
  base: IS_DESKTOP ? './' : '/',
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    inspectAttr(), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    // FUSE 挂载上 public 海量静态资源拷贝偶发 ENOENT：VITE_SKIP_PUBLIC=1 时跳过，
    // 由构建脚本先自行 rsync public → dist/public（幂等、可断点续传）
    copyPublicDir: process.env.VITE_SKIP_PUBLIC !== "1",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Rollup CJS helper 模块（无依赖）：固定进 vendor-react，
          // 否则它会落入 vendor 造成 vendor-react <-> vendor 循环 chunk
          if (id.includes("commonjsHelpers")) return "vendor-react"
          if (!id.includes("node_modules")) return undefined
          if (
            /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run|cookie|set-cookie-parser|turbo-stream)(\/|$)/.test(
              id
            )
          )
            return "vendor-react"
          if (id.includes("node_modules/framer-motion") || id.includes("node_modules/motion"))
            return "vendor-motion"
          if (
            id.includes("node_modules/three") ||
            id.includes("node_modules/@react-three")
          )
            return "vendor-three"
          return "vendor"
        },
      },
    },
  },
}
})
