#!/usr/bin/env python3
"""
Build The Film Room dataset — weekly + season advanced metrics for RB/WR/TE.

Writes: assets/data/nflverse/film-room.json

Data sources (verified against real Week 4 2026 data before shipping):
  1. nflverse stats_player_week_YYYY.parquet
     → fp, carries, rushing_yards, receptions, targets, receiving_yards,
       target_share, air_yards_share, wopr, racr, explosive-play counters
  2. nflverse NGS rushing/receiving weekly data (import_ngs_data)
     → RYOE/att, efficiency, time-to-LOS, loaded box %, separation, cushion,
       aDOT, catch %, avg YAC, YAC+/exp
  3. nflverse pbp YYYY (import_pbp_data) — slimmed to filter columns
     → red zone touches, goal line carries (NOT in weekly stats directly)
  4. nflverse seasonal_rosters YYYY (import_seasonal_rosters)
     → rookie flag (entry_year == season), sleeper_id for roster join

Writes BOTH per-week records and season aggregates for RB, WR, TE in one file.

Called from .github/workflows/update-nflverse.yml after fetch-nflverse.py.
"""
import json
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

import pandas as pd
import nfl_data_py as nfl

SEASON = int(datetime.now(timezone.utc).year)
# NFL season starts in Sept; before Aug use previous season for stale-data safety
if datetime.now(timezone.utc).month < 8:
    SEASON -= 1

REPO = Path(__file__).resolve().parent.parent.parent
OUT = REPO / "assets" / "data" / "nflverse" / "film-room.json"


def log(msg):
    print(f"[film-room] {msg}", flush=True)


def norm_name(name):
    if not isinstance(name, str):
        return ""
    return re.sub(r"[^a-z\s]", "", name.lower()).strip()


def round_or_none(v, nd=2):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        return round(float(v), nd)
    except Exception:
        return None


def int_or_none(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        return int(float(v))
    except Exception:
        return None


def main():
    log(f"Season: {SEASON}")

    # ── 1. Weekly stats ──
    url_week = f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{SEASON}.parquet"
    log(f"Fetching weekly stats: {url_week}")
    try:
        w = pd.read_parquet(url_week, engine="auto")
    except Exception as e:
        log(f"Weekly stats fetch failed: {e}")
        log("Writing empty film-room.json with status=error")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({
            "season": SEASON, "status": "error", "error": str(e),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "weekly": {"RB": [], "WR": [], "TE": []},
            "season_totals": {"RB": [], "WR": [], "TE": []},
        }, indent=2))
        sys.exit(0)
    if "week" not in w.columns or w.empty:
        log("No usable weekly data yet (preseason?)")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({
            "season": SEASON, "status": "no_data",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "weekly": {"RB": [], "WR": [], "TE": []},
            "season_totals": {"RB": [], "WR": [], "TE": []},
        }, indent=2))
        sys.exit(0)

    max_week = int(w["week"].max())
    log(f"Weeks available: 1..{max_week}, rows: {len(w):,}")

    # ── 2. Rosters (for rookie flag + sleeper_id join) ──
    log("Fetching seasonal rosters...")
    try:
        rosters = nfl.import_seasonal_rosters([SEASON])
        rookie_ids = set(rosters[rosters["entry_year"] == SEASON]["player_id"].dropna())
        gsis_to_sleeper = dict(zip(
            rosters["player_id"].astype(str),
            rosters["sleeper_id"].astype(str) if "sleeper_id" in rosters.columns else ""
        ))
    except Exception as e:
        log(f"Rosters fetch failed: {e}")
        rookie_ids = set()
        gsis_to_sleeper = {}

    # ── 3. NGS rushing/receiving ──
    log("Fetching NGS rushing...")
    try:
        ngs_r = nfl.import_ngs_data(stat_type="rushing", years=[SEASON])
    except Exception as e:
        log(f"NGS rushing failed: {e}")
        ngs_r = pd.DataFrame()
    log("Fetching NGS receiving...")
    try:
        ngs_rec = nfl.import_ngs_data(stat_type="receiving", years=[SEASON])
    except Exception as e:
        log(f"NGS receiving failed: {e}")
        ngs_rec = pd.DataFrame()

    # ── 4. PBP (slim — just RZ/GL info) ──
    log("Fetching PBP (slim)...")
    try:
        pbp = nfl.import_pbp_data(
            years=[SEASON], downcast=True,
            columns=["week", "yardline_100", "rush_attempt", "rusher_player_id",
                     "pass_attempt", "complete_pass", "receiver_player_id"]
        )
    except Exception as e:
        log(f"PBP failed: {e}")
        pbp = pd.DataFrame()

    # Build per-week RZ/GL lookups: {(week, player_id): count}
    rz_rush_by_week, rz_tgt_by_week, gl_rush_by_week = {}, {}, {}
    season_rz_rush, season_rz_tgt, season_gl_rush = {}, {}, {}
    if not pbp.empty:
        rz = pbp[pbp["yardline_100"] <= 20]
        gl = pbp[(pbp["yardline_100"] <= 5) & (pbp["rush_attempt"] == 1)]
        # per-week
        for (wk, pid), cnt in rz[rz["rush_attempt"] == 1].groupby(["week", "rusher_player_id"]).size().items():
            rz_rush_by_week[(int(wk), pid)] = int(cnt)
        rz_pass = rz[rz["pass_attempt"] == 1].dropna(subset=["receiver_player_id"])
        for (wk, pid), cnt in rz_pass.groupby(["week", "receiver_player_id"]).size().items():
            rz_tgt_by_week[(int(wk), pid)] = int(cnt)
        for (wk, pid), cnt in gl.groupby(["week", "rusher_player_id"]).size().items():
            gl_rush_by_week[(int(wk), pid)] = int(cnt)
        # season
        for pid, cnt in rz[rz["rush_attempt"] == 1].groupby("rusher_player_id").size().items():
            season_rz_rush[pid] = int(cnt)
        for pid, cnt in rz_pass.groupby("receiver_player_id").size().items():
            season_rz_tgt[pid] = int(cnt)
        for pid, cnt in gl.groupby("rusher_player_id").size().items():
            season_gl_rush[pid] = int(cnt)

    # NGS lookup helpers — key by (week, player_gsis_id)
    def ngs_r_week(wk, pid):
        if ngs_r.empty:
            return {}
        row = ngs_r[(ngs_r["week"] == wk) & (ngs_r["player_gsis_id"] == pid)]
        if row.empty:
            return {}
        r = row.iloc[0]
        return {
            "rz_rush": None,  # filled from pbp
            "ryoe_per_att": round_or_none(r.get("rush_yards_over_expected_per_att")),
            "ryoe_pct": round_or_none(r.get("rush_pct_over_expected"), 3),
            "efficiency": round_or_none(r.get("efficiency")),
            "ttlos": round_or_none(r.get("avg_time_to_los")),
            "box8_pct": round_or_none(r.get("percent_attempts_gte_eight_defenders"), 1),
        }

    def ngs_r_season(pid):
        if ngs_r.empty:
            return {}
        row = ngs_r[(ngs_r["week"] == 0) & (ngs_r["player_gsis_id"] == pid)]
        if row.empty:
            return {}
        r = row.iloc[0]
        return {
            "ryoe_per_att": round_or_none(r.get("rush_yards_over_expected_per_att")),
            "ryoe_pct": round_or_none(r.get("rush_pct_over_expected"), 3),
            "efficiency": round_or_none(r.get("efficiency")),
            "ttlos": round_or_none(r.get("avg_time_to_los")),
            "box8_pct": round_or_none(r.get("percent_attempts_gte_eight_defenders"), 1),
        }

    def ngs_rec_week(wk, pid):
        if ngs_rec.empty:
            return {}
        row = ngs_rec[(ngs_rec["week"] == wk) & (ngs_rec["player_gsis_id"] == pid)]
        if row.empty:
            return {}
        r = row.iloc[0]
        return {
            "sep": round_or_none(r.get("avg_separation")),
            "cushion": round_or_none(r.get("avg_cushion")),
            "adot": round_or_none(r.get("avg_intended_air_yards")),
            "catch_pct": round_or_none(r.get("catch_percentage"), 1),
            "ngs_yac": round_or_none(r.get("avg_yac")),
            "yac_vs_exp": round_or_none(r.get("avg_yac_above_expectation")),
        }

    def ngs_rec_season(pid):
        if ngs_rec.empty:
            return {}
        row = ngs_rec[(ngs_rec["week"] == 0) & (ngs_rec["player_gsis_id"] == pid)]
        if row.empty:
            return {}
        r = row.iloc[0]
        return {
            "sep": round_or_none(r.get("avg_separation")),
            "cushion": round_or_none(r.get("avg_cushion")),
            "adot": round_or_none(r.get("avg_intended_air_yards")),
            "catch_pct": round_or_none(r.get("catch_percentage"), 1),
            "ngs_yac": round_or_none(r.get("avg_yac")),
            "yac_vs_exp": round_or_none(r.get("avg_yac_above_expectation")),
        }

    # Pull site-generated signals (YPRR, TPRR, Snap %, Route %) from existing files
    log("Loading site-generated advanced metrics from existing files...")
    site_wm = {}
    site_route = {}
    site_snap = {}
    for name, bucket in [
        ("waiver-metrics.json", site_wm),
        ("route-participation.json", site_route),
        ("snap-counts.json", site_snap),
    ]:
        p = REPO / "assets" / "data" / "nflverse" / name
        if p.exists():
            try:
                d = json.loads(p.read_text())
                for pl in d.get("players", {}).values():
                    bucket[norm_name(pl.get("name"))] = pl
            except Exception as e:
                log(f"Warning: could not load {name}: {e}")

    def pick_weekly(name_idx, name, week, key, container="weekly"):
        rec = name_idx.get(name)
        if not rec:
            return None
        for item in rec.get(container, []):
            if item.get("week") == week:
                return item.get(key)
        return None

    def pick_season(name_idx, name, keys):
        """Return first non-None season key hit."""
        rec = name_idx.get(name)
        if not rec:
            return None
        for k in keys:
            if rec.get(k) is not None:
                return rec.get(k)
        return None

    def snap_season_avg(name):
        """Snap-counts.json has no pre-computed season field — avg from weeks[]."""
        rec = site_snap.get(name)
        if not rec:
            return None
        vals = [w.get("off_pct") for w in (rec.get("weeks") or []) if w.get("off_pct") is not None]
        return (sum(vals) / len(vals)) if vals else None

    # ── 5. Build WEEKLY records (one row per player per week) ──
    log("Building weekly records...")
    output = {
        "season": SEASON,
        "weeks_played": max_week,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "ok",
        "weekly": {"RB": [], "WR": [], "TE": []},
        "season_totals": {"RB": [], "WR": [], "TE": []},
    }

    for pos in ["RB", "WR", "TE"]:
        sub = w[(w["position"] == pos) & (w["week"] <= max_week)].copy()
        for _, row in sub.iterrows():
            pid = row.get("player_id")
            name = row.get("player_display_name") or row.get("player_name") or ""
            key = norm_name(name)
            wk = int(row.get("week"))
            team = row.get("team") or ""
            opp = row.get("opponent_team") or ""

            car = int_or_none(row.get("carries")) or 0
            rush_yds = round_or_none(row.get("rushing_yards"), 1) or 0
            rush_td = int_or_none(row.get("rushing_tds")) or 0
            tgt = int_or_none(row.get("targets")) or 0
            rec = int_or_none(row.get("receptions")) or 0
            rec_yds = round_or_none(row.get("receiving_yards"), 1) or 0
            rec_td = int_or_none(row.get("receiving_tds")) or 0
            fp = round_or_none(row.get("fantasy_points_ppr"), 1) or 0

            rec_yac = row.get("receiving_yards_after_catch") or 0
            yac_per_rec = round(float(rec_yac) / rec, 2) if rec else None

            base = {
                "player_id": pid,
                "sleeper_id": gsis_to_sleeper.get(str(pid)) or None,
                "name": name,
                "team": team,
                "opp": opp,
                "week": wk,
                "rookie": pid in rookie_ids,
                "snap_pct": round_or_none(pick_weekly(site_snap, key, wk, "off_pct", "weeks"), 3),
                "route_pct": round_or_none(pick_weekly(site_route, key, wk, "route_pct"), 3),
                "tgt": tgt, "rec": rec, "rec_yds": rec_yds, "rec_td": rec_td,
                "car": car, "rush_yds": rush_yds, "rush_td": rush_td,
                "ypc": round_or_none(rush_yds / car, 2) if car else None,
                "yac_per_rec": yac_per_rec,
                "tgt_share": round_or_none(row.get("target_share"), 3),
                "ay_share": round_or_none(row.get("air_yards_share"), 3),
                "wopr": round_or_none(row.get("wopr"), 2),
                "racr": round_or_none(row.get("racr"), 2),
                "exp_10_rush": int_or_none(row.get("rushing_10")),
                "exp_20_rush": int_or_none(row.get("rushing_20")),
                "exp_40_rush": int_or_none(row.get("rushing_40")),
                "exp_20_rec": int_or_none(row.get("receiving_20")),
                "exp_40_rec": int_or_none(row.get("receiving_40")),
                "fp": fp,
            }

            if pos == "RB":
                base["tprr"] = None  # not applicable
                base["yprr"] = None
                base["rz_rush"] = rz_rush_by_week.get((wk, pid), 0)
                base["rz_tgt"] = rz_tgt_by_week.get((wk, pid), 0)
                base["rz_touches"] = base["rz_rush"] + base["rz_tgt"]
                base["gl_car"] = gl_rush_by_week.get((wk, pid), 0)
                base["hvt"] = car + 2 * tgt
                base.update(ngs_r_week(wk, pid))
            else:  # WR / TE
                base["tprr"] = round_or_none(pick_weekly(site_wm, key, wk, "target_rate"), 2)
                base["yprr"] = round_or_none(pick_weekly(site_wm, key, wk, "yprr"), 2)
                base["rz_tgt"] = rz_tgt_by_week.get((wk, pid), 0)
                base.update(ngs_rec_week(wk, pid))

            output["weekly"][pos].append(base)

    # ── 6. Build SEASON TOTALS (aggregate across all played weeks) ──
    log("Building season totals...")
    num_sum_cols = [
        "carries", "rushing_yards", "rushing_tds", "rushing_first_downs",
        "rushing_10", "rushing_20", "rushing_40",
        "targets", "receptions", "receiving_yards", "receiving_tds",
        "receiving_yards_after_catch", "receiving_20", "receiving_40",
        "fantasy_points_ppr",
    ]
    share_cols = ["target_share", "air_yards_share", "wopr", "racr"]
    have_sum = [c for c in num_sum_cols if c in w.columns]
    have_share = [c for c in share_cols if c in w.columns]

    grp = w.groupby(["player_id", "player_display_name", "position", "team"]).agg(
        **{c: (c, "sum") for c in have_sum},
        **{c: (c, "mean") for c in have_share},
        games=("week", "nunique"),
    ).reset_index()

    for _, row in grp.iterrows():
        pos = row["position"]
        if pos not in ("RB", "WR", "TE"):
            continue
        pid = row["player_id"]
        name = row["player_display_name"] or ""
        key = norm_name(name)
        g = int(row.get("games") or 0) or 1

        car = int_or_none(row.get("carries")) or 0
        rush_yds = round_or_none(row.get("rushing_yards"), 1) or 0
        rush_td = int_or_none(row.get("rushing_tds")) or 0
        tgt = int_or_none(row.get("targets")) or 0
        rec = int_or_none(row.get("receptions")) or 0
        rec_yds = round_or_none(row.get("receiving_yards"), 1) or 0
        rec_td = int_or_none(row.get("receiving_tds")) or 0
        fp = round_or_none(row.get("fantasy_points_ppr"), 1) or 0
        rec_yac = row.get("receiving_yards_after_catch") or 0

        # Season snap/route — snap-counts has no top-level season field,
        # so avg from weeks[]; route-participation has season_route_pct.
        snap_pct = round_or_none(snap_season_avg(key), 3)
        route_pct = round_or_none(pick_season(site_route, key, ["season_route_pct"]), 3)
        yprr = round_or_none(pick_season(site_wm, key, ["season_yprr"]), 2)
        tprr = round_or_none(pick_season(site_wm, key, ["season_target_rate"]), 2)

        base = {
            "player_id": pid,
            "sleeper_id": gsis_to_sleeper.get(str(pid)) or None,
            "name": name,
            "team": row.get("team") or "",
            "games": g,
            "rookie": pid in rookie_ids,
            "snap_pct": snap_pct,
            "route_pct": route_pct,
            "car": car, "rush_yds": rush_yds, "rush_td": rush_td,
            "tgt": tgt, "rec": rec, "rec_yds": rec_yds, "rec_td": rec_td,
            "ypc": round_or_none(rush_yds / car, 2) if car else None,
            "yac_per_rec": round(float(rec_yac) / rec, 2) if rec else None,
            "tgt_share": round_or_none(row.get("target_share"), 3),
            "ay_share": round_or_none(row.get("air_yards_share"), 3),
            "wopr": round_or_none(row.get("wopr"), 2),
            "racr": round_or_none(row.get("racr"), 2),
            "exp_10_rush": int_or_none(row.get("rushing_10")),
            "exp_20_rush": int_or_none(row.get("rushing_20")),
            "exp_40_rush": int_or_none(row.get("rushing_40")),
            "exp_20_rec": int_or_none(row.get("receiving_20")),
            "exp_40_rec": int_or_none(row.get("receiving_40")),
            "fp": fp,
            "fp_per_g": round(fp / g, 1),
        }

        if pos == "RB":
            base["tprr"] = None
            base["yprr"] = None
            base["rz_rush"] = season_rz_rush.get(pid, 0)
            base["rz_tgt"] = season_rz_tgt.get(pid, 0)
            base["rz_touches"] = base["rz_rush"] + base["rz_tgt"]
            base["gl_car"] = season_gl_rush.get(pid, 0)
            base["hvt"] = car + 2 * tgt
            base["hvt_per_g"] = round(base["hvt"] / g, 1)
            base["touches_per_g"] = round((car + tgt) / g, 1)
            base.update(ngs_r_season(pid))
        else:
            base["tprr"] = tprr
            base["yprr"] = yprr
            base["rz_tgt"] = season_rz_tgt.get(pid, 0)
            base.update(ngs_rec_season(pid))

        output["season_totals"][pos].append(base)

    # Sort each list by fantasy points desc
    for pos in ["RB", "WR", "TE"]:
        output["weekly"][pos].sort(key=lambda x: x.get("fp") or 0, reverse=True)
        output["season_totals"][pos].sort(key=lambda x: x.get("fp") or 0, reverse=True)

    # ── 7. Write ──
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, indent=2))
    log(f"Wrote {OUT}")
    log(f"  Weekly: RB={len(output['weekly']['RB'])}, WR={len(output['weekly']['WR'])}, TE={len(output['weekly']['TE'])}")
    log(f"  Season: RB={len(output['season_totals']['RB'])}, WR={len(output['season_totals']['WR'])}, TE={len(output['season_totals']['TE'])}")


if __name__ == "__main__":
    main()
