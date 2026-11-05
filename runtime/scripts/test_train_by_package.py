#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="train-by-package-") as tmp:
    tmp_path = pathlib.Path(tmp)
    rows = []
    for index in range(1, 13):
        task = f"真实任务{index}"
        content = f"【合格产出】合格结果{index}"
        if index == 1:
            content += "\n第二行\t含制表符"
        rows.append(f"{index}\tdept-finance-lead\tapprove\t{task.encode().hex()}\t{content.encode().hex()}")
    rows.append(f"99\tdept-finance-lead\treject\t{'错误任务'.encode().hex()}\t{'【驳回批注】错误示范'.encode().hex()}")
    fake_mysql = tmp_path / "mysql"
    fake_mysql.write_text("#!/usr/bin/env python3\nprint(" + repr("\n".join(rows) + "\n") + ")", encoding="utf-8")
    fake_mysql.chmod(0o755)
    out = tmp_path / "samples.jsonl"
    env = os.environ.copy()
    env.update({
        "PATH": f"{tmp_path}:{env['PATH']}",
        "TRAINING_STATION_PREFIX": "dept-finance",
        "TRAINING_DB_CNF": str(tmp_path / "db.cnf"),
        "TRAINING_FACTORY_ID": "1",
        "TRAINING_SAMPLE_OUT": str(out),
    })
    result = subprocess.run(["python3", str(ROOT / "scripts/train_by_package.py"), "dept_finance"], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    train_rows = [json.loads(line) for line in out.read_text().splitlines()]
    eval_rows = [json.loads(line) for line in (tmp_path / "samples.jsonl.eval.jsonl").read_text().splitlines()]
    reject_rows = [json.loads(line) for line in (tmp_path / "samples.jsonl.reject.jsonl").read_text().splitlines()]
    assert len(train_rows) == 10, len(train_rows)
    assert len(eval_rows) == 2, len(eval_rows)
    assert len(reject_rows) == 1
    assert all(row["sample_kind"] == "approve" for row in eval_rows)
    assert all(row["input"] != row["response"] for row in train_rows)
    assert {row["input"] for row in train_rows}.isdisjoint({row["input"] for row in eval_rows})
    all_responses = [row["response"] for row in train_rows] + [row["expected"] for row in eval_rows]
    assert any("第二行\t含制表符" in response for response in all_responses)
    assert all("dept" not in row for row in train_rows)

    missing = tmp_path / "missing.jsonl"
    env["TRAINING_STATION_PREFIX"] = ""
    env["TRAINING_SAMPLE_OUT"] = str(missing)
    denied = subprocess.run(["python3", str(ROOT / "scripts/train_by_package.py"), "dept_finance"], env=env, capture_output=True, text=True)
    assert denied.returncode != 0
    assert not missing.exists()
    print("TRAIN_BY_PACKAGE_OK")
