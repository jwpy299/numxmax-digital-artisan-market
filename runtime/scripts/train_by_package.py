#!/usr/bin/env python3
"""Build train/held-out JSONL from real station samples; never invent task inputs or labels."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from typing import Iterable

PREFIX_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
APPROVE = "approve"


def decode_hex(value: str) -> str:
    if value == "NULL":
        return ""
    try:
        return bytes.fromhex(value).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise SystemExit("样本 HEX 解码失败——停止训练，不静默丢行") from exc


def parse_mysql_rows(stdout: str) -> list[dict[str, str]]:
    rows = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 4)
        if len(parts) != 5:
            raise SystemExit("样本列数异常——停止训练，不静默丢行")
        sample_id, station_key, sample_kind, task_hex, content_hex = parts
        rows.append({
            "id": sample_id,
            "station_key": station_key,
            "sample_kind": sample_kind,
            "input": decode_hex(task_hex).strip(),
            "content": decode_hex(content_hex).strip(),
        })
    return rows


def approved_response(content: str) -> str:
    return content.removeprefix("【合格产出】").strip()


def split_datasets(rows: Iterable[dict[str, str]]) -> tuple[list[dict], list[dict], list[dict]]:
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    rejected = []
    for row in rows:
        task = row["input"].strip()
        if not task:
            continue
        if row["sample_kind"] != APPROVE:
            rejected.append({
                "station_key": row["station_key"],
                "sample_kind": row["sample_kind"],
                "input": task,
                "content": row["content"],
            })
            continue
        response = approved_response(row["content"])
        if not response:
            continue
        groups[(row["station_key"], task)].append({
            "sample_id": int(row["id"]),
            "station_key": row["station_key"],
            "input": task,
            "response": response,
        })
    if not groups:
        raise SystemExit("approve 且含 task_digest 的样本为 0——不训")
    ordered_keys = sorted(groups, key=lambda key: hashlib.sha256(f"{key[0]}\0{key[1]}".encode("utf-8")).hexdigest())
    eval_group_count = max(1, round(len(ordered_keys) * 0.2))
    eval_keys = set(ordered_keys[-eval_group_count:])
    train = [item for key in ordered_keys if key not in eval_keys for item in groups[key]]
    held_out = [item for key in ordered_keys if key in eval_keys for item in groups[key]]
    if len(train) < 8:
        raise SystemExit(f"训练分组后 approve 不足：{len(train)}<8——不训")
    if len(held_out) < 2:
        raise SystemExit(f"held-out 分组后评测样本不足：{len(held_out)}<2——拒绝给分")
    train_rows = [{
        "sample_id": item["sample_id"],
        "station_key": item["station_key"],
        "instruction": "你是部门数字员工，请按任务要求生成合格产出。",
        "input": item["input"],
        "response": item["response"],
    } for item in train]
    eval_rows = [{
        "sample_id": item["sample_id"],
        "station_key": item["station_key"],
        "sample_kind": APPROVE,
        "input": item["input"],
        "expected": item["response"],
    } for item in held_out]
    return train_rows, eval_rows, rejected


def main() -> None:
    pkg = sys.argv[1] if len(sys.argv) > 1 else ""
    if not pkg or not PREFIX_RE.fullmatch(pkg):
        raise SystemExit("PKG 形态非法")
    prefix = os.environ.get("TRAINING_STATION_PREFIX", "")
    if not prefix or not PREFIX_RE.fullmatch(prefix):
        raise SystemExit("TRAINING_STATION_PREFIX 未配置或非法——拒绝无部门域/全域混训")
    cnf = os.environ.get("TRAINING_DB_CNF")
    if not cnf:
        raise SystemExit("TRAINING_DB_CNF 未配置")
    factory_id = os.environ.get("TRAINING_FACTORY_ID", "")
    if not factory_id.isdigit():
        raise SystemExit("TRAINING_FACTORY_ID 未配置或非法")
    output = os.environ.get("TRAINING_SAMPLE_OUT")
    if not output:
        raise SystemExit("TRAINING_SAMPLE_OUT 未配置")
    query = (
        "SELECT id, station_key, sample_kind, HEX(task_digest), HEX(content) FROM dsh_sandbox.nh_training_samples "
        f"WHERE factory_id={int(factory_id)} AND station_key LIKE '{prefix}%' ORDER BY id"
    )
    result = subprocess.run(
        ["mysql", "--defaults-extra-file=" + cnf, "wb_rebuild", "--batch", "--raw", "--skip-column-names", "-e", query],
        check=True,
        capture_output=True,
        text=True,
    )
    train_rows, eval_rows, reject_rows = split_datasets(parse_mysql_rows(result.stdout))
    os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        for row in train_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(output + ".eval.jsonl", "w", encoding="utf-8") as handle:
        for row in eval_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(output + ".reject.jsonl", "w", encoding="utf-8") as handle:
        for row in reject_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"SAMPLES_WRITTEN={len(train_rows)} EVAL_ROWS={len(eval_rows)} REJECT_ROWS={len(reject_rows)} PKG={pkg} PREFIX={prefix}")


if __name__ == "__main__":
    main()
