#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

train_by_package = load("train_by_package")
train_lora = load("train_lora")
generation_utils = load("generation_utils")
eval_reviewer = load("eval_reviewer")

# HEX 保留 tab/newline，异常列不得静默丢行。
try:
    train_by_package.parse_mysql_rows("bad-column-count\n")
    raise AssertionError("expected column failure")
except SystemExit:
    pass

class FakeTokenizer:
    eos_token_id = 99
    def __call__(self, text, **kwargs):
        limit = kwargs.get("max_length", 1024)
        return {"input_ids": list(text.encode("utf-8"))[:limit]}

example = train_lora.build_training_example({"input": "任务A", "response": "答案B"}, FakeTokenizer())
prompt_length = example["labels"].count(-100)
assert prompt_length > 0
assert example["labels"][:prompt_length] == [-100] * prompt_length
assert len(example["input_ids"][:prompt_length]) == prompt_length
assert example["labels"][-1] == 99
assert example["input_ids"][-1] == 99
assert len(example["input_ids"]) == len(example["labels"]) == len(example["attention_mask"])
assert all(isinstance(value, int) for value in example["input_ids"])

class Ids(list):
    @property
    def shape(self):
        return (1, len(self))

class GenerateTokenizer:
    eos_token_id = 99
    def __call__(self, _text, **_kwargs):
        return {"input_ids": Ids([1, 2, 3])}
    def decode(self, ids, **_kwargs):
        return f"decoded:{list(ids)}"

class FakeModel:
    def generate(self, **_kwargs):
        return [Ids([1, 2, 3, 4, 5, 99])]

from contextlib import nullcontext
text, finish = generation_utils.generate_new_text(FakeModel(), GenerateTokenizer(), "真实任务", nullcontext, max_new_tokens=3)
assert text == "decoded:[4, 5, 99]", text
assert finish == "stop"
assert "decoded:[1, 2, 3" not in text

with tempfile.TemporaryDirectory(prefix="training-eval-rows-") as tmp:
    path = pathlib.Path(tmp) / "eval.jsonl"
    path.write_text("\n".join([
        json.dumps({"sample_kind": "approve", "input": "任务1", "expected": "答案1"}, ensure_ascii=False),
        json.dumps({"sample_kind": "approve", "input": "任务2", "expected": "答案2"}, ensure_ascii=False),
        json.dumps({"sample_kind": "reject", "input": "任务3", "expected": "错误示范"}, ensure_ascii=False),
    ]), encoding="utf-8")
    rows = eval_reviewer.load_approved_eval_rows(str(path))
    assert len(rows) == 2 and all(row["input"] != row["expected"] for row in rows)
    path.write_text(json.dumps({"sample_kind": "approve", "input": "任务", "expected": ""}), encoding="utf-8")
    try:
        eval_reviewer.load_approved_eval_rows(str(path))
        raise AssertionError("expected empty reference rejection")
    except SystemExit:
        pass

run_text = (SCRIPTS / "run_training.sh").read_text()
assert "mkdir -p /opt/train/sandboxes/$VER" in run_text
assert "$SAMPLE_OUT.eval.jsonl" in run_text
assert "train_lora.py" in run_text and "eval_reviewer.py" in run_text and "generation_utils.py" in run_text
assert 'bash "$SCRIPT_DIR/start_inference.sh"' in run_text
start_text = (SCRIPTS / "start_inference.sh").read_text()
assert "INFERENCE_PORT_IN_USE" in start_text
assert "INFERENCE_VERSION_OR_PID_MISMATCH" not in start_text  # 错误文案只在验证脚本，不由 shell 假造
assert "verify_inference.py" in start_text
assert "INFERENCE_ALREADY_RUNNING" in start_text
subprocess.run(["bash", "-n", str(SCRIPTS / "run_training.sh")], check=True)
subprocess.run(["bash", "-n", str(SCRIPTS / "start_inference.sh")], check=True)

# 当前 S4 缺 torch/transformers/peft 时必须明确失败，不得出现健康页。
work = pathlib.Path("/opt/numxmax/training-sandbox/v65-missing-runtime")
(work / "base").mkdir(parents=True, exist_ok=True)
(work / "final").mkdir(parents=True, exist_ok=True)
(work / "base/config.json").write_text("{}")
(work / "final/adapter_config.json").write_text("{}")
result = subprocess.run(["bash", str(SCRIPTS / "start_inference.sh"), "v65-missing-runtime", str(work)], capture_output=True, text=True)
assert result.returncode != 0, result.stdout + result.stderr
assert "INFERENCE_RUNTIME_MISSING=torch/transformers/peft" in result.stdout + result.stderr

# 端口已被其他进程占用时必须失败，不得把对方健康页认成当前版本。
import socket
with tempfile.TemporaryDirectory(prefix="inference-fake-python-") as fake_dir:
    fake_python = pathlib.Path(fake_dir) / "python3"
    fake_python.write_text("#!/bin/bash\nexit 0\n")
    fake_python.chmod(0o755)
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 19999))
    sock.listen(1)
    env = os.environ.copy()
    env["PATH"] = f"{fake_dir}:{env['PATH']}"
    env["INFERENCE_PORT"] = "19999"
    try:
        occupied = subprocess.run(["bash", str(SCRIPTS / "start_inference.sh"), "v66-port-conflict", str(work)], env=env, capture_output=True, text=True)
        assert occupied.returncode != 0, occupied.stdout + occupied.stderr
        assert "INFERENCE_PORT_IN_USE=19999" in occupied.stdout + occupied.stderr
        probe = socket.create_connection(("127.0.0.1", 19999), timeout=2)
        probe.close()
    finally:
        sock.close()
print("TRAINING_SCRIPTS_OK")
