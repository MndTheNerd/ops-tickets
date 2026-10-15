"""Read-only database connections for packs. Credentials come from an env file the
person points to (never from the plugin or its config), or from process env vars."""

import os
from pathlib import Path


def _env(src):
    values = dict(os.environ)
    path = src.get("env_file")
    if path:
        for line in Path(os.path.expanduser(path)).read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    keys = src.get("keys", {})
    get = lambda name: values.get(keys.get(name, ""), "")  # noqa: E731
    return {"host": get("host"), "port": get("port"), "dbname": get("dbname"), "user": get("user"),
            "password": get("password")}


def connect(src):
    c = _env(src)
    driver = src.get("driver", "postgres")
    if driver == "postgres":
        import psycopg2
        conn = psycopg2.connect(host=c["host"], port=c["port"] or 5432, dbname=c["dbname"], user=c["user"],
                                password=c["password"], connect_timeout=15)
        conn.set_session(readonly=True)
        return conn
    if driver == "mysql":
        import pymysql
        conn = pymysql.connect(host=c["host"], port=int(c["port"] or 3306), database=c["dbname"], user=c["user"],
                               password=c["password"], connect_timeout=15)
        with conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
        return conn
    raise ValueError(f"Unsupported database driver: {driver}")
