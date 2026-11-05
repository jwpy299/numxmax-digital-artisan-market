#!/usr/bin/env python3
"""Report a parsed evaluation score through the audited adminTraining.evalReport endpoint."""
import json
import os
import sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: report_training_eval.py <pkg> <version> <score>")
    pkg, version, raw_score = sys.argv[1:]
    score = int(raw_score)
    if not 0 <= score <= 100:
        raise SystemExit("评测分数越界——拒绝回写")
    base = (os.environ.get("TRAINING_ADMIN_URL") or "http://127.0.0.1:3472").strip().rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SystemExit("TRAINING_ADMIN_URL 形态无效——只允许无凭据的 http/https 管理端基址")
    secret = os.environ.get("TRAINING_RUNNER_SECRET", "")
    if len(secret) < 32:
        raise SystemExit("TRAINING_RUNNER_SECRET 未配或过短——拒绝训练后无审计回写")
    payload = {"json": {"pkg": pkg, "version": version, "score": score, "note": "对拉评测完成", "runnerSecret": secret}}
    request = Request(
        f"{base}/api/trpc/adminTraining.evalReport",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
    except Exception as exc:
        raise SystemExit(f"训练评测审计回写失败：{type(exc).__name__}") from None
    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        raise SystemExit("训练评测审计回写失败：管理端返回非 JSON") from None
    if result.get("error"):
        raise SystemExit("训练评测审计回写失败：管理端拒绝版本/状态或凭证")
    data = result.get("result", {}).get("data", {})
    value = data.get("json", data) if isinstance(data, dict) else data
    if not isinstance(value, dict) or value.get("ok") is not True or value.get("score") != score:
        raise SystemExit("训练评测审计回写失败：管理端响应契约不符")
    print(f"EVAL_REPORT_AUDITED={score}")


if __name__ == "__main__":
    main()
