---
name: ops-collect
description: Collect alerts for the ops-tickets plugin from connected sources (Sentry, AWS CloudWatch, GitHub) and feed them to its engine. Used by /ops-run and the daily routine; arguments name the sources to collect (e.g. "sentry aws github").
---

# Collect alerts for ops-tickets

The ops-tickets engine cannot reach connectors itself, so you collect for it. For each source named in the
arguments (only those), read the last 26 hours, convert every alert to the normalized format below, and
send them all to the engine in one call. Read-only: never resolve, assign, comment on or change anything
in these systems.

## 1. Where the engine is and what is configured

The engine is `engine/opsdesk.py` in this plugin's folder. Run:

```bash
python "<plugin folder>/engine/opsdesk.py" config-get sources
```

(Use the Python command from the plugin's `python` setting if `python` is not on PATH.) The result says,
per source, what to read: `sentry.organization` / `sentry.projects`, `aws.region` / `aws.profile`,
`github.repos`.

## 2. Collect, per source

Use whatever this session has: a connector (MCP tools whose names contain sentry, aws/cloudwatch or
github) first, else the official CLI if it is installed and logged in (`aws`, `gh`). If a source has
neither, skip it and say so at the end. Never ask for or handle secrets yourself.

- **Sentry**: unresolved issues seen in the last 26 hours, for the configured organization (and projects,
  if listed). One alert per issue.
- **AWS CloudWatch**: alarms currently in ALARM, plus alarms whose history shows a transition to ALARM in
  the last 26 hours. One alert per state change.
- **GitHub**: workflow runs in the last 26 hours for the configured repos whose name looks like a deploy
  or release (deploy, release, publish, production, prod) or that run on tags. One alert per run.

## 3. Normalized alert format

A JSON list. Every field is a string unless noted; leave out what the source does not give.

| field | Sentry | CloudWatch | GitHub |
|---|---|---|---|
| `source` | `"sentry"` | `"cloudwatch"` | `"deploy"` |
| `key` | short id, e.g. `APP-1Z` | alarm name | `owner/repo@<tag or branch or run id>` |
| `at` | last seen, ISO 8601 UTC | state change time | run update time |
| `title` | issue title | alarm description (or name) | `Deploy to <environment or workflow name>` |
| `message` | error value / message | the state reason | the actor |
| `culprit` | culprit / transaction | | |
| `project` | project slug | | |
| `level` | `error` / `fatal` / `warning` | | |
| `events` | total event count, as a number string | | |
| `users` | users affected, as a number string | | |
| `state` | `Ongoing` / `New` / `Regressed` | `ALARM` / `OK` | `Passed` / `Failed` / `Started` / `Cancelled` |
| `first_seen` | first seen date | | |
| `url` | issue link | console link | run link |

## 4. Send them

Write the list to a temporary file and run:

```bash
python "<plugin folder>/engine/opsdesk.py" ingest-alerts <file> --format json
```

Then delete the temporary file and reply with one short line per source: how many alerts were sent, or
why it was skipped. The person opens the results with /tickets.
