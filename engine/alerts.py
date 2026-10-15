"""Alerts in, findings out.

Two ways in:
  parse(raw)      the text Slack's slack_read_channel returns (detailed format) for a channel
                  where Sentry, AWS CloudWatch (Amazon Q / AWS Chatbot) and GitHub deploy bots post
  from_json(raw)  a JSON list of normalized alerts, for collectors that read a connector directly:
                  {"source": "sentry"|"cloudwatch"|"deploy"|"custom", "key", "at" (ISO 8601), "title",
                   "message", "culprit", "project", "level", "events", "users", "state", "first_seen", "url"}

findings() groups them into tickets: Sentry issues merged by root cause (rules), spikes from
Sentry's running event counts, CloudWatch alarms that fired, deploys whose latest run failed.
"""

import html
import json
import re
from datetime import datetime, timezone

HEADER = re.compile(r"^=== Message from (?P<who>.+?) at (?P<at>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d) ===", re.M)
SPIKE_FACTOR = 3

# Generic root causes. A pack adds its own (PACK["alert_rules"]) ahead of these.
# group: merge every matching issue into one ticket; per_issue: one ticket each.
# owner: a name, or None to use the config's owner_rules for the source.
# known: accepted and handled elsewhere -> acknowledged, back to open only on a spike.
GENERIC_RULES = [
    {"match": r"UnreadablePostError|ClientDisconnect|ConnectionResetError|client closed request",
     "group": "network-drop", "impact": "medium", "title": "Network drop while a client sent us data",
     "meaning": "A client dropped the connection mid-upload. Each one can be a request that never arrived.",
     "steps": ["Open the Sentry issue: which endpoint and which client/IP.",
               "If one client or site dominates, check its network.",
               "Confirm the affected requests were retried or exist downstream."]},
    {"match": r"URLError|SSLError|TLS/SSL|ConnectTimeout|ReadTimeout|Max retries exceeded", "group": "outgoing-http",
     "impact": "medium", "title": "Outgoing HTTP call failing",
     "meaning": "The backend could not complete a call to another service (TLS, timeout or connection error).",
     "steps": ["Open the Sentry issue and read the URL in the breadcrumbs: which host.",
               "Check that service's status page.",
               "Add a retry with timeout around that call if it keeps happening."]},
    {"match": r"OperationalError|too many connections|could not connect to server|deadlock", "group": "database",
     "impact": "high", "title": "Database errors",
     "meaning": "Requests failed talking to the database (connections, locks or availability).",
     "steps": ["Open the Sentry issue: which query or view.",
               "Check database CPU and connection count for that time.",
               "Find the heavy or locking query and fix or index it."]},
    {"match": r"EXC_BAD_ACCESS|SIGSEGV|SIGABRT|\bfatal\b|ANR|OutOfMemory", "group": "crash", "per_issue": True,
     "impact": "high", "blocks_customers": True, "title": "App crash",
     "meaning": "The app crashed on a user's device.",
     "steps": ["Open the Sentry issue: app version, OS, how many users.",
               "Reproduce and fix; ship a hotfix if it affects many users."]},
]


def _clean(text):
    return html.unescape(text.replace("\\/", "/"))


def _num(text):
    try:
        return int(str(text).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _messages(raw):
    raw = raw.strip()
    if raw.startswith("{"):
        try:
            raw = json.loads(raw)["messages"]
        except (ValueError, KeyError):
            pass
    raw = _clean(raw)
    heads = list(HEADER.finditer(raw))
    for i, h in enumerate(heads):
        body = raw[h.end(): heads[i + 1].start() if i + 1 < len(heads) else len(raw)]
        at = datetime.strptime(h.group("at") + "00", "%Y-%m-%d %H:%M:%S %z").astimezone(timezone.utc)
        yield h.group("who"), at, body


def _field(body, name):
    m = re.search(rf"{name}: \*([^*]+)\*", body)
    return m.group(1).strip() if m else None


def parse(raw):
    """Every alert in a Slack channel dump (several pages may be concatenated)."""
    found = []
    for chunk in re.split(r"(?=\{\"messages\")", raw.strip()) if raw.strip().startswith("{") else [raw]:
        for who, at, body in _messages(chunk):
            if "Short ID:" in body and "sentry" in body.lower():
                link = re.search(r"<(https://[^|>]+/issues/\d+/)[^|>]*\|\*(.+?)\*>", body, re.S)
                code = re.search(r"```(.+?)```", body, re.S)
                after = body[link.end():] if link else body
                first_line = after.strip().split("\n", 1)[0].strip()
                culprit = first_line if first_line and not first_line.startswith(("```", "environment")) else None
                title = (link.group(2) if link else "Sentry issue").strip()
                if title.startswith("['"):
                    title = title[2:].split("'", 1)[0]
                project = re.search(r"\|([a-z0-9_-]+)>\s+Alert:", body)
                found.append({
                    "source": "sentry", "at": at, "key": re.search(r"Short ID: ([A-Z0-9-]+)", body).group(1),
                    "title": title, "culprit": culprit, "message": code.group(1).strip() if code else "",
                    "url": link.group(1) if link else "", "project": project.group(1) if project else "?",
                    "level": (re.search(r"level: `(\w+)`", body) or [None, "error"])[1],
                    "events": _field(body, "Events"), "users": _field(body, "Users Affected"),
                    "state": _field(body, "State"), "first_seen": _field(body, "First Seen"),
                })
            elif "Deploy to" in body:
                name = re.search(r"Deploy to (\w+) \(#(\w+)\) \((https://[^)]+)\)", body)
                status = re.search(r"\*(Passed|Failed|Started[^*]*|Cancelled)\*", body)
                repo = re.search(r"github\.com/([\w.-]+/[\w.-]+)\|", body)
                tag = re.search(r"refs/(?:tags|heads)/([\w./-]+)\|", body)
                found.append({
                    "source": "deploy", "at": at,
                    "key": f"{repo.group(1) if repo else '?'}@{tag.group(1) if tag else (name.group(2) if name else '?')}",
                    "state": status.group(1).split()[0] if status else "?",
                    "title": f"Deploy to {name.group(1) if name else '?'}", "url": name.group(3) if name else "",
                    "message": (re.search(r"From (\S+)", body) or [None, ""])[1],
                })
            elif "CloudWatch Alarm" in body:
                name = re.search(r"CloudWatch Alarm \| ([^|]+?) \|", body)
                state = re.search(r"\*Alarm State\*\s*\n(\w+)", body)
                desc = re.search(r"\*Alarm Description\*\s*\n(.+)", body)
                reason = re.search(r"Threshold Crossed: (.+)", body)
                url = re.search(r"<(https://[^|>]*cloudwatch[^|>]*)\|", body)
                found.append({
                    "source": "cloudwatch", "at": at, "key": name.group(1).strip() if name else "unknown-alarm",
                    "state": state.group(1) if state else "?",
                    "title": desc.group(1).strip() if desc else (name.group(1) if name else "CloudWatch alarm"),
                    "message": reason.group(1).strip() if reason else "", "url": url.group(1) if url else "",
                })
    return found


def from_json(raw):
    items = json.loads(raw) if raw.strip() else []
    result = []
    for a in items:
        a = dict(a)
        a["at"] = datetime.fromisoformat(str(a["at"]).replace("Z", "+00:00")).astimezone(timezone.utc)
        a.setdefault("title", a.get("key", "alert"))
        a.setdefault("message", "")
        a.setdefault("level", "error")
        a.setdefault("project", "?")
        a.setdefault("url", "")
        result.append(a)
    return result


def spike(alerts):
    """(is_spike, last_24h_events, usual_daily) from Sentry's running event counts."""
    pts = sorted((a["at"], _num(a.get("events"))) for a in alerts if _num(a.get("events")) is not None)
    if len(pts) < 2:
        return False, None, None
    end = pts[-1][0]
    day = [(t, n) for t, n in pts if (end - t).total_seconds() <= 86400]
    before = [(t, n) for t, n in pts if (end - t).total_seconds() > 86400]
    last24 = day[-1][1] - day[0][1] if len(day) > 1 else 0
    if not before:
        return False, last24, None
    days = max((day[0][0] - before[0][0]).total_seconds() / 86400, 1)
    usual = (day[0][1] - before[0][1]) / days
    return last24 >= max(SPIKE_FACTOR * usual, 5), last24, round(usual, 1)


def is_mobile(project):
    return bool(re.search(r"mobile|ios|android|react-?native|flutter", project or "", re.I))


def rule_for(alert, rules):
    text = f"{alert['title']} {alert['message']} {alert.get('culprit') or ''} {alert['level']} {alert.get('project')}"
    for rule in [*rules, *GENERIC_RULES]:
        if re.search(rule["match"], text, re.I):
            return rule
    return {"group": None, "per_issue": True, "impact": "high" if alert["level"] == "fatal" else "medium",
            "title": "Unclassified error", "meaning": "No known pattern yet; read the issue.",
            "steps": ["Open the issue and read the stack trace and how many users.",
                      "Decide whether it needs a fix, and who owns it."]}


def sentry_findings(alerts, rules, owner_rules):
    issues = {}
    for a in alerts:
        if a["source"] == "sentry":
            issues.setdefault(a["key"], []).append(a)
    groups = {}
    for key, hist in issues.items():
        hist.sort(key=lambda a: a["at"])
        rule = rule_for(hist[-1], rules)
        gid = key if rule.get("per_issue") or not rule.get("group") else rule["group"]
        groups.setdefault((gid, hist[-1]["project"]), (rule, []))[1].append((key, hist))
    for (gid, project), (rule, members) in groups.items():
        area = "Mobile app" if is_mobile(project) else "Backend"
        source = "Sentry mobile" if area == "Mobile app" else "Sentry backend"
        users = sum(_num(h[-1].get("users")) or 0 for _, h in members)
        spikes = [spike(h) for _, h in members]
        spiking = any(s[0] for s in spikes)
        impact = rule["impact"]
        if rule.get("blocks_customers") or users >= 20 or spiking:
            impact = "high"
        if rule.get("known") and not spiking:
            impact = "low"
        lines = []
        for (k, h), (is_spike, last24, usual) in zip(members, spikes):
            last = h[-1]
            rate = f"; last 24h +{last24} events (usual {usual}/day){' SPIKE' if is_spike else ''}" if last24 is not None else ""
            lines.append(f"{k}: {last['title'][:90]}" + (f" @ {last['culprit']}" if last.get("culprit") else "")
                         + f"\n    {last.get('events') or '?'} events, {last.get('users') or 0} users, state {last.get('state')},"
                           f" first seen {last.get('first_seen')}{rate}\n    {last['url']}")
        yield {
            "fingerprint": f"sentry:{gid}",
            "title": f"{area}: {rule['title']}" + (f" ({members[0][0]})" if len(members) == 1 else f" [{len(members)} issues]")
                     + (" - SPIKING" if spiking else ""),
            "severity": impact,
            "detail": f"What it means: {rule['meaning']}\n" + (f"Known issue: {rule['known']}\n" if rule.get("known") else "")
                      + f"Issues ({', '.join(k for k, _ in members)}), {users} users affected:\n" + "\n".join(lines),
            "action": rule["meaning"],
            "last_event": max(h[-1]["at"] for _, h in members),
            "owner": rule.get("owner") or owner_rules.get(source),
            "known": rule.get("known"),
            "spike": spiking,
            "meta": {"kind": "alert", "source": source, "store": f"{area} ({project})", "country": "Alerts",
                     "missing_in": rule["title"], "alert_key": gid, "alert_keys": [k for k, _ in members],
                     "url": members[0][1][-1]["url"], "users": users, "steps": rule["steps"]},
        }


def findings(alerts, rules=(), owner_rules=None):
    owner_rules = owner_rules or {}
    yield from sentry_findings(alerts, list(rules), owner_rules)
    by_key = {}
    for a in alerts:
        if a["source"] != "sentry":
            by_key.setdefault((a["source"], a["key"]), []).append(a)
    for (source, key), group in by_key.items():
        group.sort(key=lambda a: a["at"])
        last = group[-1]
        if source == "deploy":
            if last["state"] != "Failed":
                continue
            yield {
                "fingerprint": f"deploy:{key}", "title": f"Release: {last['title']} FAILED for {key}", "severity": "high",
                "detail": "\n".join(f"{a['at']:%m-%d %H:%M} UTC {a['state']} (by {a['message']})" for a in group) + f"\n{last['url']}",
                "action": "The latest deploy failed, so production may still be on the previous version.",
                "last_event": last["at"], "owner": owner_rules.get("Deploys"),
                "meta": {"kind": "alert", "source": "Deploys", "store": "Releases", "country": "Alerts",
                         "missing_in": "Deploy failed", "alert_key": key, "url": last["url"],
                         "steps": ["Open the CI run and read the failing step.",
                                   "Confirm which version production is running.",
                                   "Re-run or fix, then confirm a passing deploy."]},
            }
        elif source == "cloudwatch":
            alarms = [a for a in group if a["state"] == "ALARM"]
            if not alarms:
                continue
            still = last["state"] == "ALARM"
            scaling = "max-running-tasks" in key or "RUNNING state" in last["title"]
            yield {
                "fingerprint": f"cloudwatch:{key}",
                "title": f"AWS: {last['title']} ({len(alarms)} alarm(s){', STILL IN ALARM' if still else ''})",
                "severity": "high" if still or len(alarms) >= 3 else "medium",
                "detail": f"Alarm {key} went into ALARM {len(alarms)}x; latest state {last['state']} at {last['at']:%Y-%m-%d %H:%M} UTC.\n"
                          + "\n".join(f"{a['at']:%m-%d %H:%M} {a['state']}: {a['message'][:140]}" for a in group[-8:]) + f"\n{last['url']}",
                "action": ("A service hit its maximum number of running tasks: under peak load requests queue or fail."
                           if scaling else "An AWS alarm fired; open it to see the metric and when."),
                "last_event": alarms[-1]["at"], "owner": owner_rules.get("AWS"),
                "meta": {"kind": "alert", "source": "AWS", "store": "AWS (CloudWatch)", "country": "Alerts",
                         "missing_in": "Infrastructure alarm", "alert_key": key, "url": last["url"],
                         "steps": (["Open the alarm: when did the service hit its task ceiling, and for how long.",
                                    "Match it with traffic peaks and deploys.",
                                    "Raise the service's max task count or find what slows requests."] if scaling else
                                   ["Open the alarm: how long the metric stayed over the threshold, and when.",
                                    "Match the time with errors and traffic (peaks, exports, nightly jobs).",
                                    "Find the cause (heavy query, leak, traffic) or scale the resource."])},
            }
        else:
            yield {
                "fingerprint": f"{source}:{key}", "title": f"{source.title()}: {last['title']}",
                "severity": "high" if last.get("level") in ("fatal", "critical") else "medium",
                "detail": f"{last.get('message', '')}\n{last.get('url', '')}".strip(), "action": last.get("message") or "",
                "last_event": last["at"], "owner": owner_rules.get(source.title()),
                "meta": {"kind": "alert", "source": source.title(), "store": source.title(), "country": "Alerts",
                         "missing_in": last.get("state") or "Alert", "alert_key": key, "url": last.get("url", "")},
            }
