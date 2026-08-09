"""
Fetches nflverse data and outputs slim JSON files for the 12guys1cup site.

Produces:
  assets/data/nflverse/weekly-stats.json    — weekly fantasy performance per player
  assets/data/nflverse/snap-counts.json     — snap counts + week-over-week trends
  assets/data/nflverse/def-vs-pos.json      — 1-32 defense rankings per position
  assets/data/nflverse/xfp.json             — expected fantasy points (regression signals)
  assets/data/nflverse/depth-charts.json    — current team depth charts
  assets/data/nflverse/player-ids.json      — cross-reference table (FP/Sleeper/GSIS/PFR IDs)

Runs weekly on Tuesday afternoon after MNF data drops.

During offseason (before Week 1), attempts current season → falls back to prior season
so all downstream tools have data to show.
"""
import json
import os
import sys
import io
import traceback
from datetime import datetime
from urllib.request import urlopen, Request

import pandas as pd
import nfl_data_py as nfl

CURRENT_SEASON = int(os.environ.get("NFL_SEASON", datetime.now().year))
OUTPUT_DIR = "assets/data/nflverse"
FANTASY_POSITIONS = {"QB", "RB", "WR", "TE"}

# ------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------

def log(msg):
    print(f"[nflverse] {msg}", flush=True)

def write_json(data, filename):
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    size_kb = os.path.getsize(path) / 1024
    log(f"Wrote {filename} ({size_kb:.0f}KB)")

def safe(func, label):
    """Run a fetch function, return result or None on failure (with logged traceback)."""
    try:
        return func()
    except Exception as e:
        log(f"✗ {label} failed: {e}")
        traceback.print_exc()
        return None

def fetch_url_text(url, timeout=30):
    req = Request(url, headers={"User-Agent": "12guys1cup-nflverse/1.0"})
    with urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")

def num_or_none(v):
    """Convert to float, return None for NaN/missing."""
    if v is None:
        return None
    try:
        f = float(v)
        if f != f:  # NaN check
            return None
        return f
    except (TypeError, ValueError):
        return None

def int_or_none(v):
    n = num_or_none(v)
    return int(n) if n is not None else None

def try_season_with_fallback(fetcher, label):
    """Try current season, fall back to prior season if empty (for offseason)."""
    df = fetcher(CURRENT_SEASON)
    if df is not None and not df.empty:
        return df, CURRENT_SEASON
    log(f"  {label}: {CURRENT_SEASON} empty — trying {CURRENT_SEASON - 1}")
    df = fetcher(CURRENT_SEASON - 1)
    return df, CURRENT_SEASON - 1

# ------------------------------------------------------------------
# 1. Weekly player stats
# ------------------------------------------------------------------

def fetch_weekly_stats():
    log("Fetching weekly player stats…")
    df, season_used = try_season_with_fallback(
        lambda s: nfl.import_weekly_data([s]),
        "weekly stats"
    )
    if df is None or df.empty:
        return {"season": None, "weeks": [], "players": {}}

    df = df[df["position"].isin(FANTASY_POSITIONS)]
    log(f"  {len(df)} player-week rows (season {season_used})")

    players = {}
    for _, row in df.iterrows():
        pid = str(row.get("player_id") or "").strip()
        if not pid:
            continue
        if pid not in players:
            players[pid] = {
                "name": row.get("player_display_name") or row.get("player_name") or "",
                "pos": row.get("position") or "",
                "team": row.get("recent_team") or "",
                "weeks": [],
            }
        players[pid]["weeks"].append({
            "week": int_or_none(row.get("week")) or 0,
            "opp": row.get("opponent_team") or "",
            "fp": num_or_none(row.get("fantasy_points_ppr")) or 0,
            "tgts": int_or_none(row.get("targets")) or 0,
            "tgt_share": num_or_none(row.get("target_share")),
            "rec": int_or_none(row.get("receptions")) or 0,
            "rec_yds": num_or_none(row.get("receiving_yards")) or 0,
            "car": int_or_none(row.get("carries")) or 0,
            "rush_yds": num_or_none(row.get("rushing_yards")) or 0,
            "pass_yds": num_or_none(row.get("passing_yards")) or 0,
            "pass_td": int_or_none(row.get("passing_tds")) or 0,
        })

    weeks = sorted({w["week"] for p in players.values() for w in p["weeks"] if w["week"]})
    return {
        "season": season_used,
        "weeks": weeks,
        "player_count": len(players),
        "players": players,
    }

# ------------------------------------------------------------------
# 2. Snap counts (with week-over-week deltas)
# ------------------------------------------------------------------

def fetch_snap_counts():
    log("Fetching snap counts…")
    df, season_used = try_season_with_fallback(
        lambda s: nfl.import_snap_counts([s]),
        "snap counts"
    )
    if df is None or df.empty:
        return {"season": None, "players": {}}

    log(f"  {len(df)} snap rows (season {season_used})")

    players = {}
    for _, row in df.iterrows():
        pid = str(row.get("pfr_player_id") or row.get("player_id") or "").strip()
        name = row.get("player") or ""
        if not pid and not name:
            continue
        key = pid or name.lower().replace(" ", "-")

        if key not in players:
            players[key] = {
                "name": name,
                "pos": row.get("position") or "",
                "team": row.get("team") or "",
                "weeks": [],
            }
        players[key]["weeks"].append({
            "week": int_or_none(row.get("week")) or 0,
            "off_snaps": int_or_none(row.get("offense_snaps")) or 0,
            "off_pct": num_or_none(row.get("offense_pct")),
            "def_snaps": int_or_none(row.get("defense_snaps")) or 0,
            "def_pct": num_or_none(row.get("defense_pct")),
            "st_snaps": int_or_none(row.get("st_snaps")) or 0,
        })

    # Add week-over-week delta as a convenience field
    for p in players.values():
        p["weeks"].sort(key=lambda w: w["week"])
        prev = None
        for w in p["weeks"]:
            if prev is not None and prev.get("off_pct") is not None and w.get("off_pct") is not None:
                w["off_pct_delta"] = round(w["off_pct"] - prev["off_pct"], 3)
            prev = w

    return {
        "season": season_used,
        "player_count": len(players),
        "players": players,
    }

# ------------------------------------------------------------------
# 3. DEF vs POS (1-32 ranking of defenses per position)
# ------------------------------------------------------------------

def compute_def_vs_pos(weekly_stats_data):
    """Compute avg fantasy points allowed by each defense to each position."""
    log("Computing DEF vs POS rankings…")
    if not weekly_stats_data or not weekly_stats_data.get("players"):
        return {"season": None, "defenses": {}}

    season = weekly_stats_data.get("season")

    # Rebuild a wide-format list of (opp_team, week, position, fantasy_points)
    rows = []
    for p in weekly_stats_data["players"].values():
        pos = p.get("pos")
        if pos not in FANTASY_POSITIONS:
            continue
        for w in p["weeks"]:
            opp = w.get("opp")
            if not opp:
                continue
            rows.append({
                "opp": opp,
                "week": w["week"],
                "pos": pos,
                "fp": w["fp"],
            })

    if not rows:
        return {"season": season, "defenses": {}}

    df = pd.DataFrame(rows)

    # Sum fantasy points per (defense, week, position), then average across weeks
    per_game = df.groupby(["opp", "week", "pos"], as_index=False)["fp"].sum()
    per_def = per_game.groupby(["opp", "pos"], as_index=False).agg(
        avg=("fp", "mean"),
        games=("week", "count"),
    )

    result = {}
    for pos in FANTASY_POSITIONS:
        pos_data = per_def[per_def["pos"] == pos].sort_values("avg").reset_index(drop=True)
        for rank, row in pos_data.iterrows():
            team = row["opp"]
            if team not in result:
                result[team] = {}
            result[team][pos] = {
                "rank": int(rank + 1),  # 1 = best defense (fewest points allowed)
                "avg_allowed": round(float(row["avg"]), 1),
                "games": int(row["games"]),
            }

    log(f"  {len(result)} defenses ranked across {len(FANTASY_POSITIONS)} positions")
    return {"season": season, "defenses": result}

# ------------------------------------------------------------------
# 4. Expected Fantasy Points (xFP) — from ff_opportunity releases
# ------------------------------------------------------------------

def fetch_xfp():
    """Direct fetch of ff_opportunity data (not in nfl_data_py)."""
    log("Fetching expected fantasy points (xFP)…")
    for season in [CURRENT_SEASON, CURRENT_SEASON - 1]:
        url = f"https://github.com/nflverse/nflverse-data/releases/download/ff_opportunity/ep_weekly_{season}.csv"
        try:
            log(f"  trying {season}")
            text = fetch_url_text(url)
            df = pd.read_csv(io.StringIO(text))
            if df.empty:
                continue
            log(f"  {len(df)} rows loaded")
            return build_xfp_dataset(df, season)
        except Exception as e:
            log(f"  {season}: {e}")
            continue
    return {"season": None, "players": {}}

def build_xfp_dataset(df, season):
    # Filter to relevant fields; column names in ff_opportunity vary slightly by season
    # Common columns: player_id, player_name, week, position, total_yards_gained_exp, total_fantasy_points_exp, ...
    result = {}
    for _, row in df.iterrows():
        pid = str(row.get("player_id") or "").strip()
        name = row.get("player_name") or row.get("full_name") or ""
        pos = row.get("position") or ""
        if pos not in FANTASY_POSITIONS:
            continue
        key = pid or name.lower().replace(" ", "-")
        if key not in result:
            result[key] = {"name": name, "pos": pos, "weeks": []}
        result[key]["weeks"].append({
            "week": int_or_none(row.get("week")) or 0,
            "opp": row.get("opponent_team") or row.get("posteam") or "",
            "xfp": num_or_none(row.get("total_fantasy_points_exp"))
                   or num_or_none(row.get("expected_fantasy_points")),
            "actual_fp": num_or_none(row.get("total_fantasy_points"))
                         or num_or_none(row.get("fantasy_points_ppr")),
        })

    # Compute cumulative xFP vs actual
    for p in result.values():
        total_xfp = sum(w.get("xfp") or 0 for w in p["weeks"])
        total_actual = sum(w.get("actual_fp") or 0 for w in p["weeks"])
        p["total_xfp"] = round(total_xfp, 1)
        p["total_actual"] = round(total_actual, 1)
        p["gap"] = round(total_actual - total_xfp, 1)  # positive = lucky, negative = unlucky

    log(f"  {len(result)} players with xFP data")
    return {"season": season, "players": result}

# ------------------------------------------------------------------
# 5. Depth charts (current week snapshot)
# ------------------------------------------------------------------

def fetch_depth_charts():
    log("Fetching depth charts…")
    df, season_used = try_season_with_fallback(
        lambda s: nfl.import_depth_charts([s]),
        "depth charts"
    )
    if df is None or df.empty:
        return {"season": None, "teams": {}}

    # Take most recent week per team
    df["week"] = pd.to_numeric(df["week"], errors="coerce")
    latest_week = int(df["week"].max())
    df = df[df["week"] == latest_week]

    teams = {}
    for _, row in df.iterrows():
        team = row.get("club_code") or row.get("team")
        if not team:
            continue
        if team not in teams:
            teams[team] = []
        teams[team].append({
            "pos": row.get("position") or "",
            "depth": row.get("depth_position") or row.get("formation") or "",
            "order": int_or_none(row.get("depth_team")) or 0,
            "name": row.get("full_name") or row.get("football_name") or "",
            "gsis_id": row.get("gsis_id") or "",
        })

    for team in teams.values():
        team.sort(key=lambda p: (p["pos"], p["order"]))

    log(f"  {len(teams)} teams, week {latest_week}")
    return {"season": season_used, "week": latest_week, "teams": teams}

# ------------------------------------------------------------------
# 6. Player ID cross-reference (for matching FP <-> nflverse <-> Sleeper)
# ------------------------------------------------------------------

def fetch_player_ids():
    log("Fetching player ID cross-reference table…")
    try:
        df = nfl.import_ids()
    except Exception as e:
        log(f"  failed: {e}")
        return {"players": {}}

    if df is None or df.empty:
        return {"players": {}}

    log(f"  {len(df)} players in ID table")

    result = {}
    for _, row in df.iterrows():
        name = row.get("name") or row.get("mfl_name") or ""
        if not name:
            continue
        key = name.lower().strip()
        result[key] = {
            "name": name,
            "pos": row.get("position") or "",
            "team": row.get("team") or "",
            "gsis_id": str(row.get("gsis_id") or ""),
            "sleeper_id": str(row.get("sleeper_id") or ""),
            "fantasypros_id": str(row.get("fantasypros_id") or ""),
            "pfr_id": str(row.get("pfr_id") or ""),
            "espn_id": str(row.get("espn_id") or ""),
            "yahoo_id": str(row.get("yahoo_id") or ""),
        }

    return {"player_count": len(result), "players": result}

# ------------------------------------------------------------------
# main
# ------------------------------------------------------------------

def main():
    started = datetime.now()
    log(f"nflverse fetch starting — target season {CURRENT_SEASON}")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 1. Weekly stats (used by DEF vs POS + regression baseline)
    weekly = safe(fetch_weekly_stats, "weekly_stats") or {"season": None, "weeks": [], "players": {}}
    write_json(weekly, "weekly-stats.json")

    # 2. DEF vs POS (computed from weekly stats)
    def_vs_pos = safe(lambda: compute_def_vs_pos(weekly), "def_vs_pos") or {"season": None, "defenses": {}}
    write_json(def_vs_pos, "def-vs-pos.json")

    # 3. Snap counts
    snaps = safe(fetch_snap_counts, "snap_counts") or {"season": None, "players": {}}
    write_json(snaps, "snap-counts.json")

    # 4. xFP
    xfp = safe(fetch_xfp, "xfp") or {"season": None, "players": {}}
    write_json(xfp, "xfp.json")

    # 5. Depth charts
    depth = safe(fetch_depth_charts, "depth_charts") or {"season": None, "teams": {}}
    write_json(depth, "depth-charts.json")

    # 6. Player IDs (for cross-referencing)
    ids = safe(fetch_player_ids, "player_ids") or {"players": {}}
    write_json(ids, "player-ids.json")

    # Manifest
    manifest = {
        "fetched_at": started.isoformat() + "Z",
        "duration_seconds": (datetime.now() - started).total_seconds(),
        "target_season": CURRENT_SEASON,
        "files": {
            "weekly-stats.json": {"season": weekly.get("season"), "player_count": weekly.get("player_count", 0)},
            "def-vs-pos.json":   {"season": def_vs_pos.get("season"), "defenses": len(def_vs_pos.get("defenses", {}))},
            "snap-counts.json":  {"season": snaps.get("season"), "player_count": snaps.get("player_count", 0)},
            "xfp.json":          {"season": xfp.get("season"), "player_count": len(xfp.get("players", {}))},
            "depth-charts.json": {"season": depth.get("season"), "week": depth.get("week")},
            "player-ids.json":   {"player_count": ids.get("player_count", 0)},
        },
    }
    write_json(manifest, "_manifest.json")

    log(f"Done in {manifest['duration_seconds']:.1f}s")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e}")
        traceback.print_exc()
        sys.exit(1)
