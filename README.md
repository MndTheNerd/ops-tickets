# ops-tickets

A Claude Code plugin that turns your production health into a ticket list you can work through: it watches your
database, alert channels and services, opens one ticket per real problem (not per alert), tells you what it means
and how to fix it, lets you mark it fixed after a live re-check, and reopens it if it comes back.

![pane](docs/pane.png)

## What it does

- **One ticket per problem.** Repeated alerts become one ticket; Sentry issues with the same root cause are merged.
- **Says what to do.** Every ticket has a plain-language explanation, a step-by-step checklist and an owner.
- **Verify, then fix.** "Verify now" re-checks the live source; "Mark fixed" asks you to confirm and note what you
  did. If the problem returns after the fix, the ticket reopens as a **regression**.
- **Known issues stay quiet.** Acknowledge a ticket that is owned elsewhere: it drops to the bottom and only comes back
  if its error rate **spikes** (3x its usual daily rate).
- **Notifications only for what changed:** a new high-priority problem, a regression, or a spike.
- **Filters and export:** by status, source and owner; export what you see to Excel.

## Sources

| Source | How it connects | What it checks |
|---|---|---|
| Database (Postgres, MySQL) | An env file on your machine with a **read-only** login; direct or through a tunnel (Cloudflare, SSH) | Your own SQL rules, plus any packs |
| Slack alert channel | Claude's Slack connector | Messages from Sentry, AWS CloudWatch (Amazon Q / AWS Chatbot) and GitHub deploy bots |
| Sentry | A Sentry connector (or CLI) | Issues, users affected, spikes |
| AWS CloudWatch | An AWS connector or the AWS CLI | Alarms in ALARM |
| GitHub | The GitHub connector or `gh` | Failed deploys and release workflows |
| Websites & APIs | Nothing to connect | Up, fast, certificate not expiring |

Slack is read by the plugin directly. Sentry, AWS and GitHub are read by Claude through whatever connector you have
(the `ops-collect` skill), so any connector or CLI that can list issues/alarms/runs works.

## Install

```
/plugin install ops-tickets --marketplace MndTheNerd/ops-tickets
```

Then run `/ops-setup`. The setup pane walks you through it:

1. **Sources** - tick what you want to watch; connectors already connected are detected.
2. **Connect** - for each source: fill in what it needs, press **Test**, or **Help me connect** and Claude walks
   you through it.
3. **Packs & owners** - pick check packs and who owns each kind of ticket.
4. **Finish** - run the first check and create the daily routine.

Requirements: Python 3.9+ on PATH (or set the plugin's `python` setting), `psycopg2` for Postgres or `pymysql` for
MySQL, `openpyxl` for Excel export.

## Commands

| Command | |
|---|---|
| `/tickets` | Open the tickets pane |
| `/ops-setup` | Open setup |
| `/ops-run` | Collect alerts and run every check now (the daily routine runs this) |
| `/ticket-show <id>`, `/ticket-fix <id> [note]`, `/ticket-reopen <id>` | From the chat |

## Packs

A pack is a Python file of checks for a specific system. Built in: **SQL rules** (your checks as queries in the
config, no code) and **URLs**. Write your own for your stack and add it in setup; see
[docs/writing-packs.md](docs/writing-packs.md).

## Sharing one ticket list

Tickets live in a local SQLite file (`~/.ops-tickets/tickets.db`). To share one list with your team, point
`tickets_db` in `~/.ops-tickets/config.json` at a shared folder everyone can write to.

## Privacy

Read-only on every source. Logins stay in your own env file or connectors; the plugin stores only paths and names.
Nothing is sent anywhere except through the connectors you set up.

## License

MIT
