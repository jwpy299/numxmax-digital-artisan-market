#!/usr/bin/env python3
"""Held-out generation comparison for independent base and LoRA models; no hard-coded score."""
import argparse
from contextlib import nullcontext
from difflib import SequenceMatcher
import json

from generation_utils import generate_new_text


def load_approved_eval_rows(path: str) -> list[dict]:
    rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    approved = []
    for row in rows:
        if row.get("sample_kind") != "approve":
            continue
        task = str(row.get("input", "")).strip()
        expected = str(row.get("expected", "")).strip()
        if not task or not expected:
            raise SystemExit("approve 评测样本缺 input/expected——拒绝给分")
        approved.append({"input": task, "expected": expected})
    if len(approved) < 2:
        raise SystemExit(f"approve held-out 评测样本不足：{len(approved)}<2——拒绝给分")
    return approved


def similarity(expected: str, actual: str) -> float:
    return SequenceMatcher(None, expected, actual).ratio()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--lora", required=True)
    parser.add_argument("--eval", required=True)
    args = parser.parse_args()

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    rows = load_approved_eval_rows(args.eval)
    tokenizer = AutoTokenizer.from_pretrained(args.base)
    base_model = AutoModelForCausalLM.from_pretrained(args.base)
    lora_model = PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained(args.base), args.lora)
    base_model.eval()
    lora_model.eval()
    base_scores = []
    lora_scores = []
    for row in rows:
        base_actual, _ = generate_new_text(base_model, tokenizer, row["input"], torch.no_grad, max_new_tokens=192)
        lora_actual, _ = generate_new_text(lora_model, tokenizer, row["input"], torch.no_grad, max_new_tokens=192)
        base_scores.append(similarity(row["expected"], base_actual))
        lora_scores.append(similarity(row["expected"], lora_actual))
    base_score = round(sum(base_scores) / len(base_scores) * 100)
    lora_score = round(sum(lora_scores) / len(lora_scores) * 100)
    print(f"基座得分：{base_score}")
    print(f"对拉得分：{lora_score}")
    print(f"对拉提升：{lora_score - base_score}")
    print(f"EVAL_SAMPLES={len(rows)}")


if __name__ == "__main__":
    main()
