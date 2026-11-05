#!/usr/bin/env python3
"""Verify the exact S4 process/version and a real generation, never another port's health page."""
import argparse
import json
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", type=int)
    parser.add_argument("pid", type=int)
    parser.add_argument("version")
    parser.add_argument("--health-only", action="store_true")
    args = parser.parse_args()
    base = f"http://127.0.0.1:{args.port}"
    with urlopen(base + "/healthz", timeout=3) as response:
        health = json.loads(response.read())
    if not health.get("ok") or not health.get("model_loaded") or health.get("source") != "s4-local":
        raise SystemExit("INFERENCE_HEALTH_FAILED")
    if int(health.get("pid", 0)) != args.pid or health.get("version") != args.version:
        raise SystemExit("INFERENCE_VERSION_OR_PID_MISMATCH")
    if args.health_only:
        print(f"INFERENCE_HEALTH_OK version={args.version} pid={args.pid}")
        return
    request = Request(
        base + "/v1/chat/completions",
        data=json.dumps({"messages": [{"role": "user", "content": " readiness check"}]}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read())
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = str(message.get("content", "")).strip()
    if not content or " readiness check" in content or "你是部门数字员工" in content:
        raise SystemExit("INFERENCE_SMOKE_FAILED_CONTENT")
    if choice.get("finish_reason") not in {"stop", "length"}:
        raise SystemExit("INFERENCE_SMOKE_FAILED_FINISH_REASON")
    print(f"INFERENCE_SMOKE_OK version={args.version} pid={args.pid}")


if __name__ == "__main__":
    main()
