#!/usr/bin/env python3
"""Prints one JSON object for the Cost tab: today, 14 days by agent, the 5 h block,
models today, and where the cost comes from (projects and sessions active today).
Source: ccusage (Claude Code + Codex logs, offline prices)."""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

HOME = os.path.expanduser("~")
TODAY = date.today()


def cc(*args):
    r = subprocess.run(["bunx", "ccusage@latest", *args, "--json", "--offline"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise SystemExit(f"ccusage {' '.join(args)}: {(r.stderr.strip().splitlines() or ['failed'])[-1]}")
    return json.loads(r.stdout)


def ymd(d):
    return d.strftime("%Y%m%d")


def project_name(path):
    """~/code/app -> app ; ~/code/app/.worktrees/fix-x -> app · fix-x."""
    parts = [x for x in path.rstrip("/").split("/") if x]
    for mark in (".worktrees", "worktrees"):
        if mark in parts:
            i = parts.index(mark)
            if i and parts[i - 1] == ".herdr" and len(parts) > i + 2:  # ~/.herdr/worktrees/<repo>/<branch>
                return f"{parts[i + 1]} · {'/'.join(parts[i + 2:])}"
            return f"{parts[i - 1] if i else '?'} · {'/'.join(parts[i + 1:]) or '?'}"
    return parts[-1] if parts else "?"


_dir_names = {}


def claude_dir_name(d):
    """A ~/.claude/projects folder's project, from the cwd its logs record (its name loses '/' vs '-')."""
    if d not in _dir_names:
        cwd = None
        folder = os.path.join(HOME, ".claude/projects", d)
        try:
            logs = sorted((f for f in os.listdir(folder) if f.endswith(".jsonl")), key=lambda f: -os.path.getmtime(os.path.join(folder, f)))
        except OSError:
            logs = []
        for f in logs[:3]:
            with open(os.path.join(folder, f), errors="replace") as fh:
                for n, line in enumerate(fh):
                    if n > 50: break
                    if '"cwd"' in line:
                        try: cwd = json.loads(line).get("cwd")
                        except ValueError: continue
                        if cwd: break
            if cwd: break
        _dir_names[d] = project_name(cwd) if cwd else d.strip("-").split("-")[-1]
    return _dir_names[d]


def claude_title(session_id):
    """custom-title (Herdr names panes) else the first user prompt, from the session's JSONL."""
    for root, _, files in os.walk(os.path.join(HOME, ".claude/projects")):
        if f"{session_id}.jsonl" in files:
            path, title, first = os.path.join(root, f"{session_id}.jsonl"), None, None
            with open(path, errors="replace") as fh:
                for line in fh:
                    if '"custom-title"' in line:
                        try: title = json.loads(line).get("customTitle") or title
                        except ValueError: pass
                    elif first is None and '"type":"user"' in line:
                        try:
                            c = json.loads(line)["message"]["content"]
                            first = c if isinstance(c, str) else next((x.get("text") for x in c if x.get("type") == "text"), None)
                        except (ValueError, KeyError, TypeError): pass
            return title or (first or "").strip().split("\n")[0][:60] or session_id[:8], claude_dir_name(os.path.basename(root))
    return session_id[:8], "?"


def codex_meta(session_path):
    """cwd from the rollout file's session_meta line, and the first user message as the title."""
    path = os.path.join(HOME, ".codex/sessions", session_path + ".jsonl")
    cwd, title = None, None
    try:
        with open(path, errors="replace") as fh:
            for n, line in enumerate(fh):
                if n > 400 or (cwd and title): break
                try: o = json.loads(line)
                except ValueError: continue
                pl = o.get("payload") or {}
                if not cwd and o.get("type") == "session_meta": cwd = pl.get("cwd")
                if not title and pl.get("type") == "user_message":
                    msg = (pl.get("message") or "").strip()
                    if msg and not msg.startswith("<"): title = msg.split("\n")[0][:60]
    except OSError:
        pass
    return title or "Codex session", project_name(cwd) if cwd else "?"


def main():
    since14 = ymd(TODAY - timedelta(days=13))
    month1 = ymd(TODAY.replace(day=1))
    with ThreadPoolExecutor(6) as ex:
        f_days = ex.submit(cc, "daily", "--since", min(since14, month1), "--by-agent")
        f_block = ex.submit(cc, "blocks", "--active")
        f_proj = ex.submit(cc, "claude", "daily", "--since", ymd(TODAY), "--instances")
        f_csess = ex.submit(cc, "claude", "session", "--since", ymd(TODAY))
        f_xsess = ex.submit(cc, "codex", "session", "--since", ymd(TODAY))
        days_raw, block_raw, proj_raw = f_days.result(), f_block.result(), f_proj.result()
        csess, xsess = f_csess.result(), f_xsess.result()

    by_day = {}
    for d in days_raw.get("daily", []):
        agents = {a["agent"]: a.get("totalCost", 0) for a in d.get("agents") or d.get("agentBreakdowns") or []}
        by_day[d["period"]] = {"cost": d["totalCost"], "agents": agents, "models": d.get("modelBreakdowns", [])}
    days = []
    for i in range(13, -1, -1):
        k = (TODAY - timedelta(days=i)).isoformat()
        e = by_day.get(k, {"cost": 0, "agents": {}})
        days.append({"date": k, "cost": round(e["cost"], 2), "agents": {a: round(c, 2) for a, c in e["agents"].items()}})
    today = by_day.get(TODAY.isoformat(), {"cost": 0, "agents": {}, "models": []})
    prev7 = [x["cost"] for x in days[-8:-1]]
    month = sum(v["cost"] for k, v in by_day.items() if k >= TODAY.replace(day=1).isoformat())

    models = sorted(({"name": m["modelName"], "cost": round(m["cost"], 2)} for m in today["models"] if m["cost"] >= 0.01),
                    key=lambda m: -m["cost"])

    b = next((x for x in block_raw.get("blocks", []) if x.get("isActive")), None)
    block = None
    if b:
        block = {"cost": round(b["costUSD"], 2), "burn": round((b.get("burnRate") or {}).get("costPerHour", 0), 2),
                 "projected": round((b.get("projection") or {}).get("totalCost", 0), 2),
                 "minutes_left": (b.get("projection") or {}).get("remainingMinutes", 0),
                 "start": b["startTime"], "end": b["endTime"]}

    # Origin: Claude by project (today only) + Codex sessions active today, grouped by their folder.
    projects = {}
    for d, rows in (proj_raw.get("projects") or {}).items():
        name = claude_dir_name(d)
        cost = sum(r.get("totalCost", 0) for r in (rows if isinstance(rows, list) else [rows]))
        projects.setdefault(name, {"name": name, "claude": 0, "codex": 0})["claude"] += cost

    sessions = []
    for s in csess.get("sessions", []):
        sessions.append({"agent": "claude", "id": s["sessionId"], "cost": s["totalCost"], "last": s.get("lastActivity"),
                         "project": claude_dir_name(s.get("projectPath", "").split("/")[0])})
    for s in xsess.get("sessions", []):
        title, proj = codex_meta(s["sessionId"])
        # shortcut: a Codex session's cost covers its whole life, not only today; fine for "where does it go".
        projects.setdefault(proj, {"name": proj, "claude": 0, "codex": 0})["codex"] += s["costUSD"]
        sessions.append({"agent": "codex", "id": s["sessionId"], "cost": s["costUSD"], "last": s.get("lastActivity"), "title": title, "project": proj})
    sessions.sort(key=lambda s: -s["cost"])
    top = sessions[:8]
    for s in top:
        if s["agent"] == "claude":
            s["title"], _ = claude_title(s["id"])
        s["cost"] = round(s["cost"], 2)
    proj_list = sorted(({**p, "claude": round(p["claude"], 2), "codex": round(p["codex"], 2), "cost": round(p["claude"] + p["codex"], 2)}
                        for p in projects.values()), key=lambda p: -p["cost"])

    json.dump({"today": round(today["cost"], 2), "today_agents": {a: round(c, 2) for a, c in today["agents"].items()},
               "yesterday": days[-2]["cost"], "avg7": round(sum(prev7) / max(1, len(prev7)), 2), "month": round(month, 2),
               "days": days, "block": block, "models": models, "projects": proj_list[:10], "sessions": top}, sys.stdout)


if __name__ == "__main__":
    main()
