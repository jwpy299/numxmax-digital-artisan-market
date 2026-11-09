# 验收索引

本目录只保存验收口径、执行器与运行记录，不存放被验收的 APK／EXE 或签名材料。每次执行均向 `verifier/runs/` 追加时间戳记录；历史版本目录不覆盖。

- `v1/`（2026-11-09 创建）：核对 APP 原证正式签名包、ARP 三白名单与 hard-closed、桌面 Authenticode／RFC3161／可信发布者、真实 Windows VM 生命周期、GitHub／SignPath／Agent 外部条件及正式上线边界。任何硬门禁未通过时退出码为 2，不允许把部分完成判成生产完成。
- `v2/`（2026-11-09 创建）：在 v1 之外增加 Windows 生命周期 PowerShell 脚本的真实解析器语法检查；只验证脚本可解析，不改变 v1 对真实 Windows VM 证据的要求。
- `v3/`（2026-11-09 创建）：增加组织安装包 OSS 资格验收，要求最终源 SHA 一致、未使用 `frontend/assets` 被剔除、GSAP 路径为零且本地组织入口完整；不把该结果当作可信签名或 Windows VM 证据。
