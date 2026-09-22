#!/usr/bin/env python3
"""
Historical Accuracy Tracking
============================
Runs every Tuesday after games. Compares:
  - Consensus projections vs actual fantasy points
  - Start/Sit implied rankings vs actual scoring order

Outputs weekly accuracy metrics to assets/data/accuracy-history.json
so we can visualize tool performance over the season.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Use nflverse to fetch actuals
try:
    import nfl_data_py as nfl
except ImportError:
    print("nfl_data_py not installed — install via pip", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = REPO_ROOT / "assets" / "data"
OUTPUT = DATA_DIR / "accuracy-history.json"

def log(msg):
    print(f"[accuracy] {msg}", flush=True)


def normalize_name(name):
    """Normalize player name for cross-source matching."""
    if not name:
        return ""
    return "".join(c for c in name.lower() if c.isalpha() or c == " ").strip()


def load_consensus():
    """Load the consensus projections file."""
    path = DATA_DIR / "projections-consensus.json"
    if not path.exists():
        log(f"No consensus file at {path}")
        return None
    with open(path) as f:
        return json.load(f)


def load_existing_history():
    """Load existing accuracy history to append to."""
    if not OUTPUT.exists():
        return {"weeks": {}, "created_at": datetime.utcnow().isoformat() + "Z"}
    with open(OUTPUT) as f:
        return json.load(f)


def fetch_actuals_direct(season):
    """Fetch weekly stats directly from nflverse-data releases.
    Bypasses nfl_data_py which uses stale URLs.

    nflverse changed their file naming in 2026: was 'stats_player_week_YYYY.parquet',
    now 'stats_player_reg_YYYY.parquet' (regular season) or
    'stats_player_regpost_YYYY.parquet' (regular + postseason).
    We use _reg_ for in-season fantasy analysis.
    """
    import pandas as pd
    url = f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_{season}.parquet"
    log(f"  Fetching directly from nflverse: stats_player_reg_{season}.parquet")
    return pd.read_parquet(url, engine='auto')


def fetch_actuals(season, week):
    """Fetch actual weekly stats from nflverse."""
    log(f"Fetching actuals for {season} Week {week}...")

    # Try direct fetch first (works with current nflverse data)
    df = None
    try:
        df = fetch_actuals_direct(season)
        log(f"  Direct fetch succeeded: {len(df)} total player-weeks")
    except Exception as e:
        log(f"  Direct fetch failed ({e}) — falling back to nfl_data_py")
        try:
            df = nfl.import_weekly_data([season])
        except Exception as e2:
            log(f"  nfl_data_py also failed: {e2}")
            return {}

    if df is None or df.empty:
        log(f"  No data available for {season} yet")
        return {}

    try:
        wk = df[df["week"] == week]
        log(f"  Week {week} rows: {len(wk)}")

        actuals = {}
        for _, row in wk.iterrows():
            # Column names differ between nfl_data_py and direct nflverse
            name = (row.get("player_display_name")
                    or row.get("player_name")
                    or row.get("full_name")
                    or "")
            if not name:
                continue
            fp_ppr = row.get("fantasy_points_ppr")
            if fp_ppr is None or (isinstance(fp_ppr, float) and fp_ppr != fp_ppr):
                fp_ppr = 0
            actuals[normalize_name(name)] = {
                "name": name,
                "pos": row.get("position", ""),
                "team": (row.get("recent_team")
                         or row.get("team")
                         or row.get("posteam")
                         or ""),
                "actual_fp": float(fp_ppr),
            }
        log(f"Loaded actuals for {len(actuals)} players")
        return actuals
    except Exception as e:
        log(f"Error parsing actuals: {e}")
        return {}


def compute_projection_accuracy(consensus, actuals):
    """Compare projections to actual outcomes."""
    if not consensus or not consensus.get("players"):
        return None

    results = {
        "by_position": {},
        "by_source": {},
        "top_hits": [],
        "top_misses": [],
    }

    all_errors = []
    by_pos = {}
    by_source = {"fp": [], "espn": [], "sleeper": [], "consensus": []}

    for key, player in consensus["players"].items():
        actual = actuals.get(key)
        if not actual:
            continue

        pos = player.get("pos", "")
        weekly = player.get("weekly", {})
        actual_pts = actual["actual_fp"]

        # Only track players with meaningful volume (proj > 3 or actual > 3)
        if weekly.get("consensus", 0) < 3 and actual_pts < 3:
            continue

        # Consensus error
        proj = weekly.get("consensus")
        if proj is not None:
            err = actual_pts - proj
            abs_err = abs(err)
            all_errors.append(abs_err)
            by_pos.setdefault(pos, []).append(abs_err)
            by_source["consensus"].append(abs_err)

            # Track hits and misses
            results["top_hits" if abs_err <= 3 else "top_misses"].append({
                "name": player.get("name"),
                "pos": pos,
                "team": player.get("team"),
                "proj": round(proj, 1),
                "actual": round(actual_pts, 1),
                "error": round(err, 1),
            })

        # Individual source errors
        for src in ["fp", "espn", "sleeper"]:
            src_proj = weekly.get(src)
            if src_proj is not None and src_proj > 0:
                by_source[src].append(abs(actual_pts - src_proj))

    def summarize(errs):
        if not errs:
            return None
        return {
            "count": len(errs),
            "mae": round(sum(errs) / len(errs), 2),  # mean absolute error
            "rmse": round((sum(e * e for e in errs) / len(errs)) ** 0.5, 2),
        }

    results["overall"] = summarize(all_errors)
    for pos, errs in by_pos.items():
        results["by_position"][pos] = summarize(errs)
    for src, errs in by_source.items():
        results["by_source"][src] = summarize(errs)

    # Sort and cap hits/misses
    results["top_hits"].sort(key=lambda x: abs(x["error"]))
    results["top_hits"] = results["top_hits"][:10]
    results["top_misses"].sort(key=lambda x: abs(x["error"]), reverse=True)
    results["top_misses"] = results["top_misses"][:10]

    return results


def determine_target_week():
    """Figure out which week we should be evaluating."""
    consensus = load_consensus()
    if not consensus:
        return None, None
    # Consensus file tracks current week; we evaluate the PREVIOUS week
    current = consensus.get("week", 0)
    season = consensus.get("season", datetime.utcnow().year)
    target = current - 1 if current > 1 else None
    return season, target


def main():
    season, week = determine_target_week()
    if not season or not week:
        log("No target week to evaluate (preseason or week 0)")
        return

    log(f"Evaluating {season} Week {week}")

    history = load_existing_history()
    key = f"{season}_W{week}"

    # Skip if already computed (unless forced)
    if key in history["weeks"] and not os.environ.get("FORCE"):
        log(f"Week {key} already evaluated — skipping (set FORCE=1 to redo)")
        return

    consensus = load_consensus()
    actuals = fetch_actuals(season, week)
    if not actuals:
        log("No actuals available — game data not published yet")
        return

    accuracy = compute_projection_accuracy(consensus, actuals)
    if not accuracy:
        log("Could not compute accuracy")
        return

    history["weeks"][key] = {
        "season": season,
        "week": week,
        "evaluated_at": datetime.utcnow().isoformat() + "Z",
        "accuracy": accuracy,
    }
    history["updated_at"] = datetime.utcnow().isoformat() + "Z"

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(history, f, indent=2)

    overall = accuracy.get("overall", {})
    log(f"Week {week} MAE: {overall.get('mae')} pts, "
        f"RMSE: {overall.get('rmse')} pts across {overall.get('count')} players")
    log(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
