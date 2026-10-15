"""SQL rules: your own checks as a query, no Python.

Each rule in config "sql_rules" is:
  {"name": "stuck_orders",                        # unique
   "sql": "select id, store, created_at from orders where status='PENDING' and created_at < now() - interval '1 hour'",
   "title": "Order {id} at {store} stuck in PENDING",   # {column} placeholders from each row
   "group_by": "store",                           # optional: one ticket per value instead of per row
   "severity": "high", "owner": "Ops",
   "steps": ["Open the order in the admin", "..."],
   "location": {"country": "{country}", "store": "{store}"}}   # optional, groups tickets in the pane

Every row the query returns is a problem. Use %(since)s in the SQL for the run's look-back start.
"""

from datetime import datetime, timezone


def _fmt(template, row):
    try:
        return template.format(**{k: ("" if v is None else v) for k, v in row.items()})
    except (KeyError, IndexError, ValueError):
        return template


def make_check(rule):
    def check(ctx, since):
        cur = ctx.cursor()
        cur.execute(rule["sql"], {"since": since} if "%(since)s" in rule["sql"] else None)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        groups = {}
        for row in rows:
            key = str(row.get(rule["group_by"])) if rule.get("group_by") else "|".join(str(v) for v in row.values())
            groups.setdefault(key, []).append(row)
        for key, members in groups.items():
            first = members[0]
            loc = {k: _fmt(v, first) for k, v in (rule.get("location") or {}).items()}
            title = _fmt(rule.get("title", rule["name"]), first)
            if len(members) > 1:
                title += f" ({len(members)} rows)"
            yield {
                "fingerprint": f"sql:{rule['name']}:{key}",
                "title": title,
                "severity": rule.get("severity", "medium"),
                "detail": "\n".join(", ".join(f"{k}={v}" for k, v in r.items()) for r in members[:15]),
                "action": rule.get("action", ""),
                "owner": rule.get("owner"),
                "last_event": datetime.now(timezone.utc),
                "meta": {"source": "SQL rules", "steps": rule.get("steps", []), **loc},
            }

    return check


def _checks():
    import opsdesk
    return [(f"sql:{r['name']}", make_check(r)) for r in opsdesk.load_config().get("sql_rules", [])]


PACK = {
    "name": "sql_rules",
    "description": "Your own checks, written as SQL queries in the config (each returned row is a problem).",
    "needs": ["database"],
    "checks": _checks(),
}
