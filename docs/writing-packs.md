# Writing a pack

A pack is one Python file that exposes `PACK`. Add it in `/ops-setup` → Packs (or in
`~/.ops-tickets/config.json` → `"packs": [{"path": "/path/to/my_pack.py"}]`).

```python
from datetime import datetime, timezone


def check_failed_payments(ctx, since):
    """Yield one finding per problem. ctx.cursor() is a read-only database cursor."""
    cur = ctx.cursor()
    cur.execute("select store, count(*) from payments where status = 'FAILED' and created_at >= %s group by store",
                (since,))
    for store, n in cur.fetchall():
        if n < 5:
            continue
        yield {
            "fingerprint": f"failed-payments:{store}",   # the identity of the problem: same problem, same value
            "title": f"{store}: {n} failed payments",
            "severity": "high",                           # high | medium | low
            "detail": f"{n} payments failed since {since:%Y-%m-%d %H:%M} UTC",
            "action": "The payment provider is declining payments at this store.",
            "last_event": datetime.now(timezone.utc),     # newest evidence (used to detect regressions)
            "owner": "Payments",                          # optional
            "meta": {"source": "Payments", "country": "Exampleland", "store": store,   # groups tickets in the pane
                     "steps": ["Check the provider dashboard", "Call the store"]},
        }


PACK = {
    "name": "my-shop",
    "description": "Payments and orders checks for My Shop.",
    "needs": ["database"],                                   # sources that must be enabled
    "checks": [("failed_payments", check_failed_payments)],
    # optional:
    # "solution_steps": lambda ticket: [...] or None,       # custom checklist per ticket
    # "default_owner": lambda check_name, meta: "Ops" or None,
    # "verify": lambda ctx, ticket, meta: (ok, message) or None,
    # "alert_rules": [{"match": r"regex", "group": "id", "title": "...", "meaning": "...", "steps": [...],
    #                  "impact": "high", "owner": "Backend", "known": "why it is accepted"}],
}
```

**Rules of thumb**

- Read-only. Never write to the systems you check.
- One finding per real problem; a stable `fingerprint` is what turns repeats into one ticket and makes regressions work.
- Put the place (`country`, `store`) in `meta`: the pane groups tickets by them.
- Write `steps` for the person fixing it, in order, ending with how to confirm.

**SQL rules** need no file: add them in the config.

```json
"sql_rules": [{
  "name": "stuck_orders",
  "sql": "select store, count(*) as n from orders where status = 'PENDING' and created_at < now() - interval '1 hour' group by store",
  "title": "{store}: {n} orders stuck in PENDING",
  "group_by": "store",
  "severity": "high",
  "owner": "Ops",
  "steps": ["Open the orders in the admin", "Check the payment status"],
  "location": {"store": "{store}"}
}]
```
