"""Engine tests: alert parsing/grouping and the ticket lifecycle.  python engine/tests/test_engine.py"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
import alerts  # noqa: E402

SLACK = r"""Channel: #alerts (C1)

=== Message from Sentry <bot> (U1) at 2026-10-15 10:30:29 +03 ===
Message TS: 1.1
:red_circle: <https:\/\/acme.sentry.io\/issues\/7\/?referrer=slack|*Error*>
```Unable to open URL: maps:0,0?q=1,2```
environment: `production`  level: `error`
State: *New*   First Seen: *Just now*
Project: <https:\/\/acme.sentry.io\/issues\/?project=1|acme-mobile>    Alert: <https:\/\/sentry.io\/x|Mobile>    Short ID: ACME-MOBILE-KB

=== Message from Sentry <bot> (U1) at 2026-10-14 22:37:27 +03 ===
Message TS: 1.2
:red_circle: <https:\/\/acme.sentry.io\/issues\/6\/?referrer=slack|*UnreadablePostError*>
\/webhook
```error during read(383) on wsgi.input```
environment: `PRD`  level: `error`
Events: *714*   Users Affected: *29*   State: *Ongoing*   First Seen: *2025-10-21*
Project: <https:\/\/acme.sentry.io\/issues\/?project=2|acme-be>    Alert: <https:\/\/sentry.io\/x|Issue>    Short ID: ACME-BE-1SR

=== Message from Sentry <bot> (U1) at 2026-10-14 22:24:26 +03 ===
Message TS: 1.3
:red_circle: <https:\/\/acme.sentry.io\/issues\/5\/?referrer=slack|*['UnreadablePostError: error during read(382) on wsgi.input', '  File', ...*>
environment: `PRD`  level: `error`
Events: *569*   Users Affected: *3*   State: *Ongoing*   First Seen: *2025-10-21*
Project: <https:\/\/acme.sentry.io\/issues\/?project=2|acme-be>    Alert: <https:\/\/sentry.io\/x|Issue>    Short ID: ACME-BE-1SS

=== Message from Amazon Q <bot> (U2) at 2026-10-15 02:20:12 +03 ===
Message TS: 1.4
Attachment: *<https:\/\/eu-central-1.console.aws.amazon.com\/cloudwatch\/home#alarm:name=api-max-running-tasks|:rotating_light: CloudWatch Alarm | api-max-running-tasks | eu-central-1 | Account: 1>*
Threshold Crossed: 1 datapoint [3.0] was greater than or equal to the threshold (3.0).
*Alarm Description*
Service api on cluster reached the max number of tasks in RUNNING state
*Alarm State*
ALARM

=== Message from  (B1) at 2026-10-15 02:15:09 +03 ===
Message TS: 1.5
Attachment: Deploy to PRD (#0f53e7fb) (https:\/\/github.com\/acme\/core\/actions\/runs\/1)
From dev1
*Failed*  :octagonal_sign:
*<https:\/\/github.com\/acme\/core|acme\/core>* (<https:\/\/github.com\/acme\/core\/tree\/refs\/tags\/1.2.3|refs\/tags\/1.2.3>)

=== Message from  (B1) at 2026-10-15 02:20:37 +03 ===
Message TS: 1.6
Attachment: Deploy to PRD (#0f53e7fb) (https:\/\/github.com\/acme\/core\/actions\/runs\/1)
From dev1
*Passed*  :tada:
*<https:\/\/github.com\/acme\/core|acme\/core>* (<https:\/\/github.com\/acme\/core\/tree\/refs\/tags\/1.2.3|refs\/tags\/1.2.3>)
"""


def test_parse_and_group():
    parsed = alerts.parse(json.dumps({"messages": SLACK}))
    keys = {(a["source"], a["key"]) for a in parsed}
    assert ("sentry", "ACME-BE-1SR") in keys and ("cloudwatch", "api-max-running-tasks") in keys
    assert ("deploy", "acme/core@1.2.3") in keys
    found = {f["fingerprint"]: f for f in alerts.findings(parsed, [], {"Sentry backend": "Backend", "Sentry mobile": "Mobile"})}
    net = found["sentry:network-drop"]  # two Sentry issues, one root cause
    assert set(net["meta"]["alert_keys"]) == {"ACME-BE-1SR", "ACME-BE-1SS"}
    assert net["severity"] == "high" and net["owner"] == "Backend"  # 32 users -> high impact
    mobile = found["sentry:ACME-MOBILE-KB"]  # unclassified, per issue
    assert mobile["owner"] == "Mobile" and mobile["meta"]["source"] == "Sentry mobile"
    assert "cloudwatch:api-max-running-tasks" in found
    assert not any(k.startswith("deploy:") for k in found), "a deploy that later passed is not a ticket"


def test_pack_rules_win_and_known_issues():
    parsed = alerts.parse(json.dumps({"messages": SLACK}))
    rule = {"match": r"maps:", "group": "directions", "owner": "App dev", "impact": "medium", "title": "Directions broken",
            "meaning": "m", "steps": ["s"], "known": "tracked in JIRA-1"}
    found = {f["fingerprint"]: f for f in alerts.findings(parsed, [rule], {})}
    d = found["sentry:directions"]
    assert d["owner"] == "App dev" and d["known"] and d["severity"] == "low"


def test_spike():
    t0 = datetime(2026, 10, 10, tzinfo=timezone.utc)
    hist = [{"at": t0 + timedelta(days=d), "events": str(100 + 10 * d)} for d in range(4)]
    hist.append({"at": t0 + timedelta(days=3, hours=23), "events": "190"})
    assert alerts.spike(hist) == (True, 60, 10.0)
    flat = hist[:-1] + [{"at": t0 + timedelta(days=3, hours=23), "events": "140"}]
    assert not alerts.spike(flat)[0]


def test_json_alerts_and_lifecycle():
    home = tempfile.mkdtemp()
    env = {**os.environ, "OPS_TICKETS_HOME": home}
    cli = [sys.executable, str(ENGINE / "opsdesk.py")]
    run = lambda *a, stdin=None: subprocess.run([*cli, *a], env=env, input=stdin, capture_output=True, text=True, check=True).stdout  # noqa: E731
    run("init")
    now = datetime.now(timezone.utc).isoformat()
    payload = json.dumps([{"source": "deploy", "key": "acme/core@2.0", "at": now, "title": "Deploy to prod", "state": "Failed",
                           "url": "https://x"}])
    assert "1 alert ticket" in run("ingest-alerts", "-", "--format", "json", stdin=payload)
    tickets = json.loads(run("json"))
    assert len(tickets) == 1 and tickets[0]["status"] == "open" and tickets[0]["steps"]
    tid = str(tickets[0]["id"])
    run("ack", tid)
    assert json.loads(run("json"))[0]["status"] == "acknowledged"
    run("fix", tid, "re-ran deploy")
    t = json.loads(run("json"))[0]
    assert t["status"] == "fixed" and t["fixed_note"] == "re-ran deploy"
    # the same failure again, newer than the fix -> regression
    later = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    run("ingest-alerts", "-", "--format", "json", stdin=payload.replace(now, later))
    t = json.loads(run("json"))[0]
    assert t["status"] == "open" and t["reopen_count"] == 1
    notes = json.loads(run("notifications"))
    assert any(n["kind"] == "reopened" for n in notes) and json.loads(run("notifications")) == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
