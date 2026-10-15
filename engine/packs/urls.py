"""URLs: is it up, is it fast, is the certificate about to expire.

config sources.urls.list: [{"name": "Website", "url": "https://example.com", "max_ms": 3000, "expect": 200}]
"""

import socket
import ssl
import time
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlparse


def probe(u):
    url, name = u["url"], u.get("name") or u["url"]
    started = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ops-tickets/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except Exception as exc:
        return {"name": name, "url": url, "ok": False, "problem": f"unreachable ({type(exc).__name__}: {exc})"}
    ms = int((time.monotonic() - started) * 1000)
    expect = u.get("expect", 200)
    if status != expect:
        return {"name": name, "url": url, "ok": False, "problem": f"HTTP {status} (expected {expect})", "ms": ms}
    if ms > u.get("max_ms", 5000):
        return {"name": name, "url": url, "ok": False, "problem": f"slow: {ms} ms (limit {u.get('max_ms', 5000)})", "ms": ms}
    days = cert_days_left(url)
    if days is not None and days < u.get("cert_warn_days", 14):
        return {"name": name, "url": url, "ok": False, "problem": f"TLS certificate expires in {days} days", "ms": ms}
    return {"name": name, "url": url, "ok": True, "ms": ms}


def cert_days_left(url):
    p = urlparse(url)
    if p.scheme != "https":
        return None
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((p.hostname, p.port or 443), timeout=10) as sock:
            with ctx.wrap_socket(sock, server_hostname=p.hostname) as s:
                exp = datetime.strptime(s.getpeercert()["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        return (exp - datetime.now(timezone.utc)).days
    except Exception:
        return None


def check_urls(ctx, since):
    for u in ctx.cfg["sources"]["urls"].get("list", []):
        r = probe(u)
        if r["ok"]:
            continue
        yield {
            "fingerprint": f"url:{r['url']}",
            "title": f"{r['name']}: {r['problem']}",
            "severity": "high" if "unreachable" in r["problem"] or r["problem"].startswith("HTTP 5") else "medium",
            "detail": f"{r['url']}\n{r['problem']}",
            "action": "Check the service, its hosting and DNS; for certificates, renew before expiry.",
            "last_event": datetime.now(timezone.utc),
            "meta": {"source": "URLs", "store": r["name"], "country": "Websites & APIs", "url": r["url"],
                     "steps": ["Open the URL yourself and confirm.", "Check the hosting/service status and recent deploys.",
                               "Fix, then press Verify now."]},
        }


PACK = {
    "name": "urls",
    "description": "Uptime, speed and certificate expiry for the URLs you list.",
    "needs": ["urls"],
    "checks": [("urls", check_urls)],
}
