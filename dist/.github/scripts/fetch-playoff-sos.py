#!/usr/bin/env python3
"""
fetch-playoff-sos.py — Build Playoff Schedule-of-Strength rankings for Weeks 15-17.

Inputs (all already produced by fetch-nflverse.py):
  assets/data/nflverse/def-vs-pos.json   — per-defense avg fantasy pts allowed to QB/RB/WR/TE

Output:
  assets/data/nflverse/playoff-sos.json

Methodology:
  DVP rank 1 = toughest defense (allows LEAST FP to position)
  DVP rank 32 = softest defense (allows MOST FP to position)

  Offense positions (QB/RB/WR/TE):
    team score = avg FP that W15, W16, W17 opponent defenses allow to the position
    Rank teams 1..32 by that score DESC (higher = easier playoff schedule)

  DST:
    team score = avg PPG scored by W15, W16, W17 opponent OFFENSES
    Rank teams 1..32 by that score ASC (lower = easier DST playoff schedule)
"""
import csv, io, json, os, sys, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "assets", "data", "nflverse")
SEASON = int(os.environ.get("NFL_SEASON", "2026"))
PLAYOFF_WEEKS = (15, 16, 17)

SCHED_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"


def log(*a):
    print("[playoff-sos]", *a, file=sys.stderr, flush=True)


def fetch_schedule():
    req = urllib.request.Request(SCHED_URL, headers={"User-Agent": "12guys1cup/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def main():
    dvp_path = os.path.join(DATA_DIR, "def-vs-pos.json")
    if not os.path.exists(dvp_path):
        log("MISSING", dvp_path, "— run fetch-nflverse.py first")
        sys.exit(1)
    dvp = json.load(open(dvp_path))["defenses"]

    rows = fetch_schedule()
    season_rows = [r for r in rows if r["season"] == str(SEASON)]
    if not season_rows:
        log(f"No {SEASON} rows in schedule"); sys.exit(1)

    # Current schedule W15-17
    sched = defaultdict(dict)
    for r in season_rows:
        wk = int(r["week"])
        if wk not in PLAYOFF_WEEKS: continue
        sched[r["away_team"]][wk] = r["home_team"]
        sched[r["home_team"]][wk] = r["away_team"]

    # PPG so far for DST matchup strength
    scored = defaultdict(list)
    through = 0
    for r in season_rows:
        if not r.get("result") or r["result"] == "": continue
        try:
            scored[r["away_team"]].append(int(r["away_score"]))
            scored[r["home_team"]].append(int(r["home_score"]))
            through = max(through, int(r["week"]))
        except Exception:
            pass
    ppg = {t: round(sum(v) / len(v), 2) for t, v in scored.items() if v}

    out = {
        "season": SEASON,
        "playoff_weeks": list(PLAYOFF_WEEKS),
        "through_week": through,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "by_position": {},
    }

    for pos in ("QB", "RB", "WR", "TE"):
        allowed = {t: dvp[t][pos]["avg_allowed"] for t in dvp if pos in dvp[t]}
        rank_of = {t: dvp[t][pos]["rank"] for t in dvp if pos in dvp[t]}
        scores = []
        for team, matches in sched.items():
            opps = []
            total_allowed = 0.0
            n = 0
            for wk in PLAYOFF_WEEKS:
                opp = matches.get(wk)
                if not opp or opp not in allowed: continue
                a = allowed[opp]; rk = rank_of[opp]
                # softness = rank itself (higher rank = softer defense = easier matchup)
                opps.append({"wk": wk, "opp": opp, "dvp_rank": rk, "avg_allowed": a, "softness": rk})
                total_allowed += a
                n += 1
            if n == 0: continue
            scores.append({
                "team": team,
                "avg_opp_allowed": round(total_allowed / n, 2),
                "softness_total": sum(o["softness"] for o in opps),
                "games": n,
                "opponents": opps,
            })
        # Sort by avg_opp_allowed DESC (higher FP allowed by opponents = easier for the offense)
        scores.sort(key=lambda x: -x["avg_opp_allowed"])
        for i, s in enumerate(scores, 1): s["rank"] = i
        out["by_position"][pos] = scores

    # DST — lower opp PPG is better
    dst_scores = []
    for team, matches in sched.items():
        opps = []; total = 0.0; n = 0
        for wk in PLAYOFF_WEEKS:
            opp = matches.get(wk)
            if not opp or opp not in ppg: continue
            opps.append({"wk": wk, "opp": opp, "opp_ppg": ppg[opp]})
            total += ppg[opp]; n += 1
        if n == 0: continue
        dst_scores.append({
            "team": team,
            "avg_opp_ppg": round(total / n, 2),
            "games": n,
            "opponents": opps,
        })
    dst_scores.sort(key=lambda x: x["avg_opp_ppg"])
    for i, s in enumerate(dst_scores, 1): s["rank"] = i
    out["by_position"]["DST"] = dst_scores

    outpath = os.path.join(DATA_DIR, "playoff-sos.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(outpath, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    log(f"wrote {outpath} through W{through}")


if __name__ == "__main__":
    main()
