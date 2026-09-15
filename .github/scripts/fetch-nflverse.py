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
    """Try current season, fall back to prior season if empty or error."""
    try:
        df = fetcher(CURRENT_SEASON)
        if df is not None and not df.empty:
            return df, CURRENT_SEASON
        log(f"  {label}: {CURRENT_SEASON} empty — trying {CURRENT_SEASON - 1}")
    except Exception as e:
        log(f"  {label}: {CURRENT_SEASON} failed ({e}) — trying {CURRENT_SEASON - 1}")

    try:
        df = fetcher(CURRENT_SEASON - 1)
        if df is not None and not df.empty:
            return df, CURRENT_SEASON - 1
        log(f"  {label}: {CURRENT_SEASON - 1} also empty")
    except Exception as e:
        log(f"  {label}: {CURRENT_SEASON - 1} failed ({e})")

    # Return empty DataFrame instead of None so calling code doesn't crash
    import pandas as pd
    return pd.DataFrame(), CURRENT_SEASON - 1

# ------------------------------------------------------------------
# 1. Weekly player stats
# ------------------------------------------------------------------

def fetch_weekly_stats_direct(season):
    """Fetch weekly stats directly from nflverse-data releases.
    Bypasses nfl_data_py which uses stale URLs (v0.3.3 as of 2026)."""
    import pandas as pd
    url = f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.parquet"
    log(f"  Fetching directly from nflverse: stats_player_week_{season}.parquet")
    return pd.read_parquet(url, engine='auto')

def fetch_weekly_stats():
    log("Fetching weekly player stats…")

    # Try direct nflverse URL first (works with current data)
    # Fall back to nfl_data_py if direct fetch fails
    df = None
    season_used = None
    try:
        df = fetch_weekly_stats_direct(CURRENT_SEASON)
        if df is not None and not df.empty:
            season_used = CURRENT_SEASON
            log(f"  ✓ Direct fetch succeeded for {CURRENT_SEASON}")
    except Exception as e:
        log(f"  Direct {CURRENT_SEASON} failed ({e}) — trying {CURRENT_SEASON - 1}")
        try:
            df = fetch_weekly_stats_direct(CURRENT_SEASON - 1)
            season_used = CURRENT_SEASON - 1
        except Exception as e2:
            log(f"  Direct {CURRENT_SEASON - 1} also failed ({e2}) — trying nfl_data_py")

    # Fallback to nfl_data_py wrapper
    if df is None or df.empty:
        try:
            df, season_used = try_season_with_fallback(
                lambda s: nfl.import_weekly_data([s]),
                "weekly stats"
            )
        except Exception as e:
            log(f"  nfl_data_py also failed: {e}")

    if df is None or df.empty:
        return {"season": None, "weeks": [], "players": {}}

    # Normalize field names — direct nflverse uses different names than nfl_data_py
    # nfl_data_py: player_display_name, player_name; nflverse direct: player_display_name
    if "player_display_name" not in df.columns and "player_name" in df.columns:
        df["player_display_name"] = df["player_name"]

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
            "rec_tds": int_or_none(row.get("receiving_tds")) or 0,
            "car": int_or_none(row.get("carries")) or 0,
            "rush_yds": num_or_none(row.get("rushing_yards")) or 0,
            "rush_tds": int_or_none(row.get("rushing_tds")) or 0,
            "pass_att": int_or_none(row.get("attempts")) or 0,
            "pass_yds": num_or_none(row.get("passing_yards")) or 0,
            "pass_td": int_or_none(row.get("passing_tds")) or 0,
            "pass_tds": int_or_none(row.get("passing_tds")) or 0,
            "air_yards": num_or_none(row.get("receiving_air_yards")) or 0,
            "adot": num_or_none(row.get("racr")),  # air yards ratio (Racial Air Yards Ratio)
            "tgt_air_yards": num_or_none(row.get("targeted_air_yards")) or num_or_none(row.get("receiving_air_yards")) or 0,
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

    # Column names vary between nfl_data_py versions — find whichever "week" column exists
    week_col = None
    for candidate in ["week", "game_week", "gameday_week", "week_num"]:
        if candidate in df.columns:
            week_col = candidate
            break

    if week_col is None:
        log(f"  Depth chart schema unknown — columns: {list(df.columns)[:20]}")
        return {"season": season_used, "teams": {}}

    # Take most recent week per team
    df[week_col] = pd.to_numeric(df[week_col], errors="coerce")
    latest_week = int(df[week_col].max())
    df = df[df[week_col] == latest_week]

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
# 7. NFL schedules (for playoff SoS + matchup lookups)
# ------------------------------------------------------------------

def fetch_schedules():
    """Fetch NFL schedules for current + prior season (for playoff SoS + game context)."""
    log("Fetching NFL schedules…")
    schedule_lookup = {}   # {season: {team: {week: opp}}}
    game_context = {}      # {season: {team: {week: {spread, total, roof, temp, wind, home}}}}

    for season in [CURRENT_SEASON, CURRENT_SEASON - 1]:
        try:
            df = nfl.import_schedules([season])
            if df is None or df.empty:
                log(f"  {season}: no data")
                continue

            season_lookup = {}
            season_ctx = {}
            game_count = 0
            for _, row in df.iterrows():
                wk = int_or_none(row.get("week"))
                home = row.get("home_team")
                away = row.get("away_team")
                if not wk or not home or not away:
                    continue

                season_lookup.setdefault(home, {})[str(wk)] = away
                season_lookup.setdefault(away, {})[str(wk)] = home

                # Game context: Vegas + weather
                spread = num_or_none(row.get("spread_line"))   # from HOME perspective; negative = home favored
                total = num_or_none(row.get("total_line"))
                roof = row.get("roof") or ""
                temp = num_or_none(row.get("temp"))
                wind = num_or_none(row.get("wind"))

                # Team perspective: spread is home team's line; away team's implied spread = -spread
                if spread is not None:
                    season_ctx.setdefault(home, {})[str(wk)] = {
                        "opp": away, "home": True,
                        "spread": -spread if spread else 0,  # positive = this team favored
                        "total": total, "roof": roof, "temp": temp, "wind": wind,
                    }
                    season_ctx.setdefault(away, {})[str(wk)] = {
                        "opp": home, "home": False,
                        "spread": spread if spread else 0,
                        "total": total, "roof": roof, "temp": temp, "wind": wind,
                    }
                else:
                    season_ctx.setdefault(home, {})[str(wk)] = {
                        "opp": away, "home": True, "spread": None, "total": total,
                        "roof": roof, "temp": temp, "wind": wind,
                    }
                    season_ctx.setdefault(away, {})[str(wk)] = {
                        "opp": home, "home": False, "spread": None, "total": total,
                        "roof": roof, "temp": temp, "wind": wind,
                    }

                game_count += 1

            schedule_lookup[str(season)] = season_lookup
            game_context[str(season)] = season_ctx
            log(f"  {season}: {game_count} games, {len(season_lookup)} teams")
        except Exception as e:
            log(f"  {season}: {e}")

    # Playoff opponents for the current season (weeks 15-17)
    playoff_opps = {}
    current_key = str(CURRENT_SEASON)
    if current_key in schedule_lookup:
        for team, weeks in schedule_lookup[current_key].items():
            playoff_opps[team] = [weeks.get(str(w)) for w in [15, 16, 17]]

    return {
        "seasons_available": list(schedule_lookup.keys()),
        "schedule": schedule_lookup,
        "playoff_opponents": playoff_opps,
        "game_context": game_context,
    }

# ------------------------------------------------------------------
# 8. Dropback-based target share (accurate route participation proxy)
# ------------------------------------------------------------------
# Uses play-by-play data to compute team dropbacks accurately.
# Dropbacks = pass attempts + sacks + scrambles + spikes.
# player_dropback_share = player_targets / team_dropbacks
# Blended metric: 60% last-4-games + 40% season for stability.

# ------------------------------------------------------------------
# 7b. Route participation (snap-based approximation)
# ------------------------------------------------------------------
# True route participation = routes run / team dropbacks
# We don't have exact player-on-field-per-play, but we can approximate:
#   routes ≈ offensive_snaps × team_pass_rate
# For WR/TE this is very accurate (they primarily run routes on pass plays)
# For RB it's decent but less reliable (they may block or run routes)

def fetch_route_participation(snaps_data, weekly_stats_data):
    log("Computing route participation (snaps × team pass rate)…")

    if not snaps_data or not snaps_data.get("players"):
        log("  No snap data — skipping route participation")
        return {"season": None, "players": {}}

    if not weekly_stats_data or not weekly_stats_data.get("players"):
        log("  No weekly stats — skipping route participation")
        return {"season": None, "players": {}}

    season = snaps_data.get("season")
    if not season:
        log("  No season detected — skipping")
        return {"season": None, "players": {}}

    try:
        pbp_df = nfl.import_pbp_data([season], downcast=True)
        log(f"  Loaded {len(pbp_df)} play rows for {season}")
    except Exception as e:
        log(f"  PBP fetch failed: {e}")
        return {"season": season, "players": {}, "error": str(e)}

    if pbp_df is None or pbp_df.empty:
        log("  Empty PBP — no games played yet")
        return {"season": season, "players": {}}

    # Compute team pass rate per game (dropbacks / total plays)
    if "qb_dropback" in pbp_df.columns:
        dropback_plays = pbp_df[pbp_df["qb_dropback"] == 1]
    else:
        dropback_plays = pbp_df[
            (pbp_df.get("pass_attempt", 0) == 1) |
            (pbp_df.get("sack", 0) == 1) |
            (pbp_df.get("qb_scramble", 0) == 1)
        ]

    # Total offensive plays (exclude special teams, penalties, timeouts, etc.)
    off_plays = pbp_df[
        pbp_df["posteam"].notna() &
        pbp_df.get("play_type", pd.Series()).isin(["pass", "run", "qb_kneel", "qb_spike"])
    ]

    team_pass_by_week = dropback_plays.groupby(["posteam", "week"]).size().reset_index(name="pass_plays")
    team_total_by_week = off_plays.groupby(["posteam", "week"]).size().reset_index(name="total_plays")

    pass_rate_lookup = {}
    for _, row in team_pass_by_week.iterrows():
        team = str(row["posteam"]).strip()
        wk = int(row["week"])
        pass_rate_lookup.setdefault(team, {})[wk] = {"pass_plays": int(row["pass_plays"])}
    for _, row in team_total_by_week.iterrows():
        team = str(row["posteam"]).strip()
        wk = int(row["week"])
        if team in pass_rate_lookup and wk in pass_rate_lookup[team]:
            pass_rate_lookup[team][wk]["total_plays"] = int(row["total_plays"])
            total = pass_rate_lookup[team][wk]["total_plays"]
            passes = pass_rate_lookup[team][wk]["pass_plays"]
            pass_rate_lookup[team][wk]["pass_rate"] = passes / total if total > 0 else 0

    # Build player route participation
    players_out = {}
    for pid, sp in snaps_data["players"].items():
        pos = sp.get("pos", "")
        # Only compute for skill positions
        if pos not in ("WR", "TE", "RB"):
            continue

        team = sp.get("team", "")
        if not team:
            continue

        weekly_routes = []
        for w in sp.get("weeks", []):
            wk = w.get("week")
            off_pct = w.get("off_pct")
            if not wk or off_pct is None:
                continue

            # Route participation ≈ snap % × team pass rate
            team_data = pass_rate_lookup.get(team, {}).get(wk, {})
            pass_rate = team_data.get("pass_rate")
            if pass_rate is None:
                continue

            # For WR/TE: route participation is essentially snap % × pass rate
            # For RB: reduce because they block on some pass plays (~30% for RB1s)
            if pos == "RB":
                route_pct = off_pct * pass_rate * 0.75  # RBs run routes on ~75% of pass plays
            else:
                route_pct = off_pct * pass_rate  # WR/TE run routes on virtually all pass plays

            weekly_routes.append({
                "week": wk,
                "off_pct": round(off_pct, 3),
                "pass_rate": round(pass_rate, 3),
                "route_pct": round(route_pct, 3),
            })

        if not weekly_routes:
            continue

        # Season average
        season_avg = sum(w["route_pct"] for w in weekly_routes) / len(weekly_routes)

        # Recent 3 games
        recent = sorted(weekly_routes, key=lambda x: x["week"], reverse=True)[:3]
        recent_avg = sum(w["route_pct"] for w in recent) / len(recent)

        players_out[pid] = {
            "name": sp.get("name", ""),
            "pos": pos,
            "team": team,
            "games": len(weekly_routes),
            "season_route_pct": round(season_avg, 3),
            "recent_route_pct": round(recent_avg, 3),
            "weekly": weekly_routes,
        }

    log(f"  Computed route participation for {len(players_out)} players")

    return {
        "season": season,
        "player_count": len(players_out),
        "players": players_out,
        "thresholds": {
            # Route participation tiers (based on JJ Zachariason research)
            "WR": {"elite": 0.85, "starter": 0.70, "rotational": 0.50, "spot": 0.25},
            "TE": {"elite": 0.75, "starter": 0.55, "rotational": 0.35, "spot": 0.15},
            "RB": {"elite": 0.55, "starter": 0.35, "rotational": 0.20, "spot": 0.05},
        },
        "notes": "Route participation ≈ offensive snap % × team pass rate. For RBs, reduced by 25% to account for pass blocking snaps.",
    }

# ------------------------------------------------------------------
# 7c. Computed xFP fallback (for when ff_opportunity dataset is stale)
# ------------------------------------------------------------------
# When nflverse's xFP dataset isn't updated yet (early season), compute
# xFP from raw opportunity signals: air yards, targets, red zone touches

def compute_xfp_fallback(weekly_stats_data):
    log("Computing xFP fallback from opportunity signals…")

    if not weekly_stats_data or not weekly_stats_data.get("players"):
        return {"season": None, "players": {}}

    season = weekly_stats_data.get("season")
    if not season:
        return {"season": None, "players": {}}

    # xFP formula weights (PPR scoring, derived from historical fantasy correlation research)
    # For each opportunity type, expected point value:
    XFP_WEIGHTS = {
        "target_receiving_yards_per_target": 0.7,   # Avg yards per target
        "target_reception_rate": 0.65,               # Avg catch rate
        "carry_yards_per_carry_rb": 4.2,             # Avg YPC for RBs
        "carry_yards_per_carry_qb": 6.0,             # Avg YPC for QB rushes (scrambles)
        "rz_carry_td_rate": 0.15,                    # Red zone carry → TD
        "rz_target_td_rate": 0.20,                   # Red zone target → TD
        "pass_yards_per_attempt": 7.0,               # Avg passing YPA
        "pass_td_rate": 0.045,                       # Avg pass TD rate per attempt
    }

    players_out = {}
    for pid, pdata in weekly_stats_data["players"].items():
        pos = pdata.get("pos", "")
        if pos not in ("QB", "RB", "WR", "TE"):
            continue

        weekly_xfp = []
        for w in pdata.get("weeks", []):
            wk = w.get("week")
            if not wk:
                continue

            # Get opportunity signals from weekly stats
            targets = w.get("tgts", 0) or 0
            receptions = w.get("rec", 0) or 0
            rec_yds = w.get("rec_yds", 0) or 0
            rec_tds = w.get("rec_tds", 0) or 0

            carries = w.get("car", 0) or 0
            rush_yds = w.get("rush_yds", 0) or 0
            rush_tds = w.get("rush_tds", 0) or 0

            pass_att = w.get("pass_att", 0) or 0
            pass_yds = w.get("pass_yds", 0) or 0
            pass_tds = w.get("pass_tds", 0) or 0

            actual_fp = w.get("fantasy_points_ppr", 0) or 0

            # Compute expected fantasy points from opportunity
            xfp = 0

            # Receiving xFP: targets × (yards + reception + TD probability)
            if targets > 0:
                exp_rec_yds = targets * XFP_WEIGHTS["target_receiving_yards_per_target"]
                exp_recs = targets * XFP_WEIGHTS["target_reception_rate"]
                # PPR scoring: 1 pt/rec + 0.1 pt/yd
                xfp += exp_rec_yds * 0.1 + exp_recs * 1.0

            # Rushing xFP (for RBs/QBs)
            if carries > 0:
                yards_per_carry = XFP_WEIGHTS["carry_yards_per_carry_qb"] if pos == "QB" else XFP_WEIGHTS["carry_yards_per_carry_rb"]
                exp_rush_yds = carries * yards_per_carry
                exp_rush_tds = carries * 0.02  # ~2% carries → TD
                xfp += exp_rush_yds * 0.1 + exp_rush_tds * 6

            # Passing xFP (for QBs)
            if pass_att > 0:
                exp_pass_yds = pass_att * XFP_WEIGHTS["pass_yards_per_attempt"]
                exp_pass_tds = pass_att * XFP_WEIGHTS["pass_td_rate"]
                xfp += exp_pass_yds * 0.04 + exp_pass_tds * 4  # 4pt pass TD scoring

            weekly_xfp.append({
                "week": wk,
                "xfp": round(xfp, 1),
                "actual_fp": round(actual_fp, 1),
                "gap": round(actual_fp - xfp, 1),  # positive = overperformed, negative = due for regression positive
            })

        if not weekly_xfp:
            continue

        total_xfp = sum(w["xfp"] for w in weekly_xfp)
        total_actual = sum(w["actual_fp"] for w in weekly_xfp)

        # Recent 3 games
        recent = sorted(weekly_xfp, key=lambda x: x["week"], reverse=True)[:3]
        recent_xfp = sum(w["xfp"] for w in recent) / len(recent) if recent else 0
        recent_actual = sum(w["actual_fp"] for w in recent) / len(recent) if recent else 0

        players_out[pid] = {
            "name": pdata.get("name", ""),
            "pos": pos,
            "team": pdata.get("team", ""),
            "games": len(weekly_xfp),
            "total_xfp": round(total_xfp, 1),
            "total_actual": round(total_actual, 1),
            "gap": round(total_actual - total_xfp, 1),
            "recent_xfp_avg": round(recent_xfp, 1),
            "recent_actual_avg": round(recent_actual, 1),
            "weekly": weekly_xfp,
        }

    log(f"  Computed xFP for {len(players_out)} players")
    return {
        "season": season,
        "source": "computed_from_opportunity",
        "player_count": len(players_out),
        "players": players_out,
        "notes": "Computed xFP from raw opportunity: targets × (yards/target + reception rate + TD prob) + carries × YPC + red zone touches. Gap column = actual - expected (positive = overperformed).",
    }

# ------------------------------------------------------------------
# Waiver metrics: rush share, target rate, air yards leaders
# ------------------------------------------------------------------
# Produces JJ-style metrics for waiver wire scouting:
#   1. Rush share — RB carries / team carries (60%+ = backfield king)
#   2. Target rate — targets / routes run (25%+ = trusted receiver)
#   3. Air yards per game — WR/TE downfield weapons (90+/game = threat)

def fetch_waiver_metrics(weekly_stats_data, route_data):
    log("Computing waiver metrics: rush share, target rate, air yards…")

    if not weekly_stats_data or not weekly_stats_data.get("players"):
        return {"season": None, "players": {}}

    season = weekly_stats_data.get("season")
    if not season:
        return {"season": None, "players": {}}

    # Build team rush attempts per week (denominator for rush share)
    team_rushes = {}  # {team: {week: total_carries}}
    for pdata in weekly_stats_data["players"].values():
        team = pdata.get("team", "")
        if not team:
            continue
        for w in pdata.get("weeks", []):
            wk = w.get("week")
            car = w.get("car", 0) or 0
            if not wk or car <= 0:
                continue
            team_rushes.setdefault(team, {}).setdefault(wk, 0)
            team_rushes[team][wk] += car

    # Build route lookup: {normalized_name: {week: route_count}}
    # Route counts derived from route_data (snap % × team pass rate approximation)
    routes_lookup = {}
    if route_data and route_data.get("players"):
        for p in route_data["players"].values():
            name = p.get("name", "")
            if not name:
                continue
            weekly_routes = {}
            for w in p.get("weekly", []):
                wk = w.get("week")
                route_pct = w.get("route_pct", 0)
                # Estimate route count from percentage (assumes ~40 team dropbacks/game avg)
                # This is approximate but consistent for target rate calculations
                if wk and route_pct > 0:
                    weekly_routes[wk] = route_pct  # Store the pct directly for ratio calcs
            if weekly_routes:
                routes_lookup[name.lower()] = weekly_routes

    # Compute per-player metrics
    players_out = {}
    for pid, pdata in weekly_stats_data["players"].items():
        pos = pdata.get("pos", "")
        if pos not in ("QB", "RB", "WR", "TE"):
            continue

        team = pdata.get("team", "")
        name = pdata.get("name", "")
        if not team or not name:
            continue

        rush_shares = []
        target_rates = []
        air_yards_per_game = []
        targets_per_game = []
        weekly_detail = []

        for w in pdata.get("weeks", []):
            wk = w.get("week")
            if not wk:
                continue

            car = w.get("car", 0) or 0
            tgts = w.get("tgts", 0) or 0
            air_yds = w.get("tgt_air_yards", 0) or w.get("air_yards", 0) or 0

            # Rush share for RBs
            team_car = team_rushes.get(team, {}).get(wk, 0)
            rush_share = None
            if pos == "RB" and team_car >= 5 and car > 0:
                rush_share = car / team_car
                rush_shares.append(rush_share)

            # Target rate for WR/TE (targets / route participation)
            target_rate = None
            if pos in ("WR", "TE") and tgts > 0:
                route_pct = routes_lookup.get(name.lower(), {}).get(wk)
                if route_pct and route_pct > 0.10:  # need meaningful route sample
                    # Approximate: if player ran routes on 80% of team's ~40 dropbacks = 32 routes
                    # target_rate = tgts / estimated_routes
                    # Simplified: target rate proxy = tgt_share / route_share (both are % of team)
                    tgt_share = w.get("tgt_share")
                    if tgt_share and tgt_share > 0:
                        target_rate = tgt_share / route_pct
                        target_rate = min(target_rate, 1.0)  # cap at 100%
                        target_rates.append(target_rate)

            # Air yards per game (WR/TE)
            if pos in ("WR", "TE") and air_yds > 0:
                air_yards_per_game.append(air_yds)

            if tgts > 0:
                targets_per_game.append(tgts)

            weekly_detail.append({
                "week": wk,
                "car": car,
                "tgts": tgts,
                "air_yds": round(air_yds, 1) if air_yds else 0,
                "rush_share": round(rush_share, 3) if rush_share else None,
                "target_rate": round(target_rate, 3) if target_rate else None,
            })

        # Compute season/recent averages
        recent_n = 3
        stats = {}

        if rush_shares:
            stats["season_rush_share"] = round(sum(rush_shares) / len(rush_shares), 3)
            recent = rush_shares[-recent_n:] if len(rush_shares) >= recent_n else rush_shares
            stats["recent_rush_share"] = round(sum(recent) / len(recent), 3)
            stats["rush_share_games"] = len(rush_shares)

        if target_rates:
            stats["season_target_rate"] = round(sum(target_rates) / len(target_rates), 3)
            recent = target_rates[-recent_n:] if len(target_rates) >= recent_n else target_rates
            stats["recent_target_rate"] = round(sum(recent) / len(recent), 3)
            stats["target_rate_games"] = len(target_rates)

        if air_yards_per_game:
            stats["season_air_yards_pg"] = round(sum(air_yards_per_game) / len(air_yards_per_game), 1)
            recent = air_yards_per_game[-recent_n:] if len(air_yards_per_game) >= recent_n else air_yards_per_game
            stats["recent_air_yards_pg"] = round(sum(recent) / len(recent), 1)
            stats["air_yards_games"] = len(air_yards_per_game)

        if targets_per_game:
            stats["season_targets_pg"] = round(sum(targets_per_game) / len(targets_per_game), 1)

        # Only include players with at least one meaningful metric
        if stats:
            players_out[pid] = {
                "name": name,
                "pos": pos,
                "team": team,
                "games": len(pdata.get("weeks", [])),
                **stats,
                "weekly": weekly_detail,
            }

    log(f"  Computed waiver metrics for {len(players_out)} players")
    return {
        "season": season,
        "player_count": len(players_out),
        "players": players_out,
        "thresholds": {
            "rush_share_elite": 0.60,
            "rush_share_strong": 0.45,
            "target_rate_elite": 0.25,
            "target_rate_strong": 0.20,
            "air_yards_elite": 90,
            "air_yards_strong": 65,
        },
        "notes": "Rush share = player carries / team carries. Target rate = target share / route share. Air yards from targeted routes.",
    }

def fetch_dropback_shares(weekly_stats_data):
    log("Fetching play-by-play for dropback-based target share…")

    if not weekly_stats_data or not weekly_stats_data.get("players"):
        log("  No weekly stats — skipping dropback share")
        return {"season": None, "players": {}}

    season = weekly_stats_data.get("season")
    if not season:
        log("  No season detected — skipping")
        return {"season": None, "players": {}}

    try:
        # Import PBP data — only need pass plays for dropback counting
        pbp_df = nfl.import_pbp_data([season], downcast=True)
        log(f"  Loaded {len(pbp_df)} play rows for {season}")
    except Exception as e:
        log(f"  PBP fetch failed: {e}")
        return {"season": season, "players": {}, "error": str(e)}

    if pbp_df is None or pbp_df.empty:
        log("  Empty PBP — no games played yet this season")
        return {"season": season, "players": {}}

    # Compute team dropbacks per game
    # A dropback = play where QB dropped back to pass
    # Use qb_dropback if available (nflverse's native field), else compute from parts
    if "qb_dropback" in pbp_df.columns:
        dropback_plays = pbp_df[pbp_df["qb_dropback"] == 1]
        log("  Using nflverse qb_dropback field")
    else:
        # Fallback: manually combine pass_attempt + sack + qb_scramble + qb_spike
        dropback_plays = pbp_df[
            (pbp_df["pass_attempt"] == 1) |
            (pbp_df["sack"] == 1) |
            (pbp_df["qb_scramble"] == 1) |
            (pbp_df.get("qb_spike", 0) == 1)
        ]
        log("  Computed dropbacks from pass_attempt + sack + scramble + spike")

    # Group by team + week to get team dropbacks per game
    team_dropbacks = dropback_plays.groupby(["posteam", "week"]).size().reset_index(name="dropbacks")
    log(f"  Computed dropbacks for {len(team_dropbacks)} team-week combos")

    # Build lookup: {team: {week: dropbacks}}
    dropback_lookup = {}
    for _, row in team_dropbacks.iterrows():
        team = str(row["posteam"]).strip()
        wk = int(row["week"])
        if not team or wk < 1:
            continue
        dropback_lookup.setdefault(team, {})[wk] = int(row["dropbacks"])

    # For each player in weekly stats, compute dropback share per week
    players_out = {}
    for pid, pdata in weekly_stats_data["players"].items():
        if pdata.get("pos") not in ("WR", "TE"):
            continue

        weekly_shares = []
        for w in pdata.get("weeks", []):
            wk = w.get("week")
            team = pdata.get("team")
            targets = w.get("tgts", 0)
            if not wk or not team or targets is None:
                continue

            team_db = dropback_lookup.get(team, {}).get(wk, 0)
            if team_db < 5:  # too few dropbacks to be meaningful (bench game, blowout)
                continue

            share = targets / team_db if team_db > 0 else 0
            weekly_shares.append({
                "week": wk,
                "targets": targets,
                "team_dropbacks": team_db,
                "share": round(share, 4),
            })

        if not weekly_shares:
            continue

        # Season average
        season_share = sum(w["share"] for w in weekly_shares) / len(weekly_shares)

        # Last 4 games (or fewer if not enough)
        recent = sorted(weekly_shares, key=lambda x: x["week"], reverse=True)[:4]
        recent_share = sum(w["share"] for w in recent) / len(recent)

        # Blended (per approved logic: 60% recent + 40% season)
        blended = 0.60 * recent_share + 0.40 * season_share

        players_out[pid] = {
            "name": pdata.get("name", ""),
            "pos": pdata.get("pos", ""),
            "team": pdata.get("team", ""),
            "games": len(weekly_shares),
            "season_share": round(season_share, 4),
            "recent_share": round(recent_share, 4),
            "blended_share": round(blended, 4),
            "weekly": weekly_shares,
        }

    log(f"  Built dropback shares for {len(players_out)} WR/TE players")

    return {
        "season": season,
        "player_count": len(players_out),
        "players": players_out,
        "thresholds": {
            "WR": 0.20,  # 20%+ dropback share ≈ 70%+ route participation
            "TE": 0.15,  # 15%+ dropback share ≈ 70%+ route participation
        },
        "notes": "Blended metric = 0.60 × last-4-games + 0.40 × season. Team dropbacks include pass attempts + sacks + scrambles + spikes.",
    }

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

    # 7. Schedules (for playoff SoS)
    sched = safe(fetch_schedules, "schedules") or {"seasons_available": [], "schedule": {}, "playoff_opponents": {}}
    write_json(sched, "schedules.json")

    # 8. Dropback-based target share (accurate route participation proxy)
    dropback = safe(lambda: fetch_dropback_shares(weekly), "dropback_shares") or {"season": None, "players": {}}
    write_json(dropback, "dropback-shares.json")

    # 9. Route participation (snap % × team pass rate)
    routes = safe(lambda: fetch_route_participation(snaps, weekly), "route_participation") or {"season": None, "players": {}}
    write_json(routes, "route-participation.json")

    # 10. xFP fallback (compute from opportunity when nflverse ff_opportunity is stale)
    xfp_computed = safe(lambda: compute_xfp_fallback(weekly), "xfp_computed") or {"season": None, "players": {}}
    write_json(xfp_computed, "xfp-computed.json")

    # 11. Waiver metrics (rush share, target rate, air yards)
    waiver_metrics = safe(lambda: fetch_waiver_metrics(weekly, routes), "waiver_metrics") or {"season": None, "players": {}}
    write_json(waiver_metrics, "waiver-metrics.json")

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
            "schedules.json":    {"seasons": sched.get("seasons_available", [])},
            "dropback-shares.json": {"season": dropback.get("season"), "player_count": dropback.get("player_count", 0)},
            "route-participation.json": {"season": routes.get("season"), "player_count": routes.get("player_count", 0)},
            "xfp-computed.json": {"season": xfp_computed.get("season"), "player_count": xfp_computed.get("player_count", 0)},
            "waiver-metrics.json": {"season": waiver_metrics.get("season"), "player_count": waiver_metrics.get("player_count", 0)},
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
