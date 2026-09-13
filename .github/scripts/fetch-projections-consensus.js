/**
 * Multi-Source Projection Consensus Builder
 *
 * Fetches weekly and rest-of-season projections from multiple sources:
 *   - FantasyPros HOF (weekly + ROS endpoints)
 *   - ESPN player projections
 *   - Sleeper (uses their internal projections)
 *
 * Averages them into a consensus projection per player per week.
 * Weights each source by historical accuracy (starts equal, could learn over time).
 *
 * Output: assets/data/projections-consensus.json
 * Structure:
 *   {
 *     week: 2,
 *     season: 2026,
 *     players: {
 *       "normalized name": {
 *         name, pos, team,
 *         weekly: { fp, espn, sleeper, consensus },
 *         ros:    { fp, espn, sleeper, consensus },
 *         sources_used: ["fp", "espn", "sleeper"],
 *         variance: 0.12  // std dev / mean, higher = more disagreement
 *       }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(REPO_ROOT, 'assets', 'data', 'projections-consensus.json');
const FP_KEY = process.env.FANTASYPROS_HOF_API_KEY;
const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const SEASON = new Date().getFullYear();
const SCORING = 'PPR';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizeName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/* ─────────────────────────────────────────────
   Source weights — can be tuned as accuracy is measured
   Higher weight = trusted more
   Total doesn't need to sum to 1 (we normalize)
   ───────────────────────────────────────────── */
const SOURCE_WEIGHTS = {
  fp: 1.0,      // FantasyPros consensus (already an aggregator)
  espn: 0.85,   // ESPN — decent but slower to react to news
  sleeper: 0.90, // Sleeper — aggregates but sometimes stale
};

/* ─────────────────────────────────────────────
   Determine current NFL week via ESPN scoreboard
   ───────────────────────────────────────────── */
async function fetchCurrentWeek() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const res = await fetch(url);
  if (!res.ok) return { week: 1, season: SEASON };
  const data = await res.json();
  return {
    week: data.week?.number || 1,
    season: data.season?.year || SEASON,
  };
}

/* ─────────────────────────────────────────────
   FantasyPros weekly projections
   Note: HOF API endpoint uses week=N for weekly instead of week=0 (season)
   ───────────────────────────────────────────── */
async function fetchFpWeekly(position, week) {
  if (!FP_KEY) return { ok: false, players: [] };
  const label = `[FP W${week} ${position}]`;
  const url = `${FP_BASE}/nfl/${SEASON}/projections?position=${position}&scoring=${SCORING}&week=${week}`;
  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': FP_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const players = (data.players || []).map(p => {
      const stats = Array.isArray(p.stats) ? (p.stats[0] || {}) : (p.stats || {});
      const pts = num(stats.points_ppr) ?? num(stats.points_half) ?? num(stats.points) ?? num(p.fantasy_pts);
      return {
        name: p.name || p.player_name,
        pos: p.position_id || p.player_position_id,
        team: p.team_id || p.player_team_id,
        pts,
      };
    }).filter(p => p.pts != null && p.pts > 0);
    console.log(`${label} ✓ ${players.length}`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [] };
  }
}

/* Rest-of-season projections from FP (season-long minus what's already played) */
async function fetchFpRos(position) {
  if (!FP_KEY) return { ok: false, players: [] };
  const label = `[FP ROS ${position}]`;
  const url = `${FP_BASE}/nfl/${SEASON}/projections?position=${position}&scoring=${SCORING}&week=0`;
  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': FP_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const players = (data.players || []).map(p => {
      const stats = Array.isArray(p.stats) ? (p.stats[0] || {}) : (p.stats || {});
      const pts = num(stats.points_ppr) ?? num(stats.points_half) ?? num(stats.points) ?? num(p.fantasy_pts);
      return {
        name: p.name || p.player_name,
        pos: p.position_id || p.player_position_id,
        team: p.team_id || p.player_team_id,
        pts,
      };
    }).filter(p => p.pts != null && p.pts > 0);
    console.log(`${label} ✓ ${players.length}`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [] };
  }
}

/* ─────────────────────────────────────────────
   ESPN weekly projections
   Uses undocumented but public endpoint that returns fantasy projections
   ───────────────────────────────────────────── */
async function fetchEspnWeekly(week) {
  const label = `[ESPN W${week}]`;
  // ESPN's fantasy projection endpoint
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leaguedefaults/3?view=kona_player_info`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'x-fantasy-filter': JSON.stringify({
          players: {
            filterStatsForTopScoringPeriodIds: {
              value: 2,
              additionalValue: [`00${SEASON}`, `10${SEASON}`, `10${SEASON}0`, `00${SEASON}0`],
            },
            sortAppliedStatTotal: { sortAsc: false, sortPriority: 3, value: `10${SEASON}0` },
            sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
            sortPercOwned: { sortPriority: 4, sortAsc: false },
            limit: 500,
            filterStatsForTopScoringPeriodIds_typing_error: 2,
          },
        }),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const players = (data.players || []).map(p => {
      const player = p.player || {};
      // Find weekly projection stat
      const stats = player.stats || [];
      const weeklyProj = stats.find(s => s.scoringPeriodId === week && s.statSourceId === 1);
      const rosProj = stats.find(s => s.statSplitTypeId === 0 && s.statSourceId === 1);

      return {
        name: player.fullName || player.firstName + ' ' + player.lastName,
        pos: mapEspnPos(player.defaultPositionId),
        team: mapEspnTeam(player.proTeamId),
        weekly_pts: weeklyProj?.appliedTotal ?? null,
        ros_pts: rosProj?.appliedTotal ?? null,
      };
    }).filter(p => p.name && (p.weekly_pts || p.ros_pts));

    console.log(`${label} ✓ ${players.length}`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [] };
  }
}

// ESPN position ID → standard position
function mapEspnPos(id) {
  const map = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
  return map[id] || null;
}

// ESPN team ID → team abbreviation
function mapEspnTeam(id) {
  const map = {
    22: 'ARI', 1: 'ATL', 33: 'BAL', 2: 'BUF', 29: 'CAR', 3: 'CHI',
    4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB',
    34: 'HOU', 11: 'IND', 30: 'JAX', 12: 'KC', 24: 'LAC', 14: 'LAR',
    13: 'LV', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG',
    20: 'NYJ', 21: 'PHI', 23: 'PIT', 26: 'SEA', 25: 'SF', 27: 'TB',
    10: 'TEN', 28: 'WAS',
  };
  return map[id] || null;
}

/* ─────────────────────────────────────────────
   Sleeper projections
   Public endpoint that returns projections for a given week
   ───────────────────────────────────────────── */
async function fetchSleeperWeekly(week) {
  const label = `[Sleeper W${week}]`;
  const url = `https://api.sleeper.com/projections/nfl/${SEASON}/${week}?season_type=regular&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF&order_by=ppr`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const players = (Array.isArray(data) ? data : []).map(entry => {
      const p = entry.player || {};
      const stats = entry.stats || {};
      return {
        name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        pos: p.position,
        team: p.team,
        pts: num(stats.pts_ppr) ?? num(stats.pts_half_ppr) ?? num(stats.pts_std),
      };
    }).filter(p => p.name && p.pts != null && p.pts > 0);
    console.log(`${label} ✓ ${players.length}`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [] };
  }
}

/* Sleeper season-long (ROS) projections */
async function fetchSleeperSeason() {
  const label = '[Sleeper Season]';
  const url = `https://api.sleeper.com/projections/nfl/${SEASON}?season_type=regular&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF&order_by=ppr`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const players = (Array.isArray(data) ? data : []).map(entry => {
      const p = entry.player || {};
      const stats = entry.stats || {};
      return {
        name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        pos: p.position,
        team: p.team,
        pts: num(stats.pts_ppr) ?? num(stats.pts_half_ppr) ?? num(stats.pts_std),
      };
    }).filter(p => p.name && p.pts != null && p.pts > 0);
    console.log(`${label} ✓ ${players.length}`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [] };
  }
}

/* ─────────────────────────────────────────────
   Weighted consensus math
   ───────────────────────────────────────────── */
function computeConsensus(values) {
  // values = { fp: 12.5, espn: 11.8, sleeper: 13.1 }
  const entries = Object.entries(values).filter(([_, v]) => v != null && v > 0);
  if (entries.length === 0) return { consensus: null, variance: null, sources: [] };
  if (entries.length === 1) return { consensus: entries[0][1], variance: 0, sources: [entries[0][0]] };

  let weightedSum = 0;
  let weightTotal = 0;
  const points = [];
  for (const [source, pts] of entries) {
    const w = SOURCE_WEIGHTS[source] || 1.0;
    weightedSum += pts * w;
    weightTotal += w;
    points.push(pts);
  }
  const consensus = weightedSum / weightTotal;

  // Coefficient of variation (std dev / mean) — measures disagreement
  const mean = points.reduce((s, v) => s + v, 0) / points.length;
  const variance = points.reduce((s, v) => s + (v - mean) ** 2, 0) / points.length;
  const stdDev = Math.sqrt(variance);
  const coefVar = mean > 0 ? stdDev / mean : 0;

  return {
    consensus: Math.round(consensus * 10) / 10,
    variance: Math.round(coefVar * 1000) / 1000,
    sources: entries.map(([s]) => s),
  };
}

/* ─────────────────────────────────────────────
   Main — orchestrate all sources and merge
   ───────────────────────────────────────────── */
async function main() {
  const { week, season } = await fetchCurrentWeek();
  console.log(`Fetching consensus projections for Week ${week}, ${season}`);

  // Fetch everything in parallel (each source is independent)
  const [
    fpWeeklyQb, fpWeeklyRb, fpWeeklyWr, fpWeeklyTe,
    fpRosQb, fpRosRb, fpRosWr, fpRosTe,
    espn,
    sleeperWeekly, sleeperSeason,
  ] = await Promise.all([
    fetchFpWeekly('QB', week),
    fetchFpWeekly('RB', week),
    fetchFpWeekly('WR', week),
    fetchFpWeekly('TE', week),
    fetchFpRos('QB'),
    fetchFpRos('RB'),
    fetchFpRos('WR'),
    fetchFpRos('TE'),
    fetchEspnWeekly(week),
    fetchSleeperWeekly(week),
    fetchSleeperSeason(),
  ]);

  // Build lookup maps: normalizedName → pts
  const fpWeeklyMap = new Map();
  [...fpWeeklyQb.players, ...fpWeeklyRb.players, ...fpWeeklyWr.players, ...fpWeeklyTe.players]
    .forEach(p => fpWeeklyMap.set(normalizeName(p.name), p));

  const fpRosMap = new Map();
  [...fpRosQb.players, ...fpRosRb.players, ...fpRosWr.players, ...fpRosTe.players]
    .forEach(p => fpRosMap.set(normalizeName(p.name), p));

  const espnMap = new Map();
  espn.players.forEach(p => espnMap.set(normalizeName(p.name), p));

  const sleeperWeeklyMap = new Map();
  sleeperWeekly.players.forEach(p => sleeperWeeklyMap.set(normalizeName(p.name), p));

  const sleeperSeasonMap = new Map();
  sleeperSeason.players.forEach(p => sleeperSeasonMap.set(normalizeName(p.name), p));

  // Union of all player names
  const allNames = new Set([
    ...fpWeeklyMap.keys(),
    ...fpRosMap.keys(),
    ...espnMap.keys(),
    ...sleeperWeeklyMap.keys(),
    ...sleeperSeasonMap.keys(),
  ]);

  const players = {};
  for (const key of allNames) {
    const fpWeekly = fpWeeklyMap.get(key);
    const fpRos = fpRosMap.get(key);
    const espnP = espnMap.get(key);
    const sleeperW = sleeperWeeklyMap.get(key);
    const sleeperS = sleeperSeasonMap.get(key);

    // Use first available for name/pos/team
    const nameSource = fpWeekly || fpRos || espnP || sleeperW || sleeperS;
    if (!nameSource?.name) continue;

    // Weekly consensus
    const weeklyValues = {
      fp: fpWeekly?.pts,
      espn: espnP?.weekly_pts,
      sleeper: sleeperW?.pts,
    };
    const weekly = computeConsensus(weeklyValues);

    // ROS consensus (weekly × games remaining, but sources give this directly)
    const rosValues = {
      fp: fpRos?.pts,
      espn: espnP?.ros_pts,
      sleeper: sleeperS?.pts,
    };
    const ros = computeConsensus(rosValues);

    players[key] = {
      name: nameSource.name,
      pos: nameSource.pos,
      team: nameSource.team,
      weekly: {
        fp: weeklyValues.fp,
        espn: weeklyValues.espn,
        sleeper: weeklyValues.sleeper,
        consensus: weekly.consensus,
        variance: weekly.variance,
      },
      ros: {
        fp: rosValues.fp,
        espn: rosValues.espn,
        sleeper: rosValues.sleeper,
        consensus: ros.consensus,
        variance: ros.variance,
      },
      sources_used: [...new Set([...(weekly.sources || []), ...(ros.sources || [])])],
    };
  }

  const output = {
    fetched_at: new Date().toISOString(),
    season,
    week,
    source_weights: SOURCE_WEIGHTS,
    player_count: Object.keys(players).length,
    sources_status: {
      fp_weekly_qb: fpWeeklyQb.ok,
      fp_weekly_rb: fpWeeklyRb.ok,
      fp_weekly_wr: fpWeeklyWr.ok,
      fp_weekly_te: fpWeeklyTe.ok,
      fp_ros_qb: fpRosQb.ok,
      fp_ros_rb: fpRosRb.ok,
      fp_ros_wr: fpRosWr.ok,
      fp_ros_te: fpRosTe.ok,
      espn: espn.ok,
      sleeper_weekly: sleeperWeekly.ok,
      sleeper_season: sleeperSeason.ok,
    },
    players,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Players: ${Object.keys(players).length}`);

  // Print consensus for a few well-known players as sanity check
  const sanity = ['jamarr chase', 'ceedee lamb', 'brock bowers', 'ashton jeanty'];
  console.log('\n=== Sanity check ===');
  sanity.forEach(key => {
    const p = players[key];
    if (p) {
      console.log(`${p.name} (${p.pos}): Weekly=${p.weekly.consensus} [FP=${p.weekly.fp}, ESPN=${p.weekly.espn}, Sleeper=${p.weekly.sleeper}]`);
    }
  });
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
