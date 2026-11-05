#!/usr/bin/env python3
"""Write a mode-600 MySQL option file without exposing the password in argv or logs."""
import os
import pathlib
import sys
from urllib.parse import unquote, urlsplit


def option_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: training_mysql_config.py <env-file> <output.cnf>")
    source, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    database_url = ""
    for line in source.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            database_url = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
    parsed = urlsplit(database_url)
    if parsed.scheme != "mysql" or not parsed.hostname or not parsed.username or parsed.password is None:
        raise SystemExit("DATABASE_URL 形态无效——无法生成训练专用 MySQL 配置")
    database = parsed.path.lstrip("/")
    if database != "wb_rebuild":
        raise SystemExit("训练 runner 只允许 wb_rebuild 库——请核 DATABASE_URL")
    body = (
        "[client]\n"
        f"user = \"{option_value(unquote(parsed.username))}\"\n"
        f"password = \"{option_value(unquote(parsed.password))}\"\n"
        f"host = \"{option_value(parsed.hostname)}\"\n"
        f"port = {parsed.port or 3306}\n"
        f"database = \"{option_value(database)}\"\n"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(output, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())


if __name__ == "__main__":
    main()
