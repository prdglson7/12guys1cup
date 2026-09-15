/* =========================================================
   Sleeper API client
   Docs: https://docs.sleeper.com/
   All Sleeper endpoints are CORS-enabled and require no key.
   ========================================================= */

const LEAGUE_ID = "1389753693590532096";
const API = "https://api.sleeper.app/v1";

/* Small helper: fetch + JSON with a helpful error */
async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`Sleeper ${path} → ${res.status}`);
  return res.json();
}

/* ---- Player DB (large: ~5MB) cached in localStorage for 24h ---- */
const PLAYER_CACHE_KEY = "sleeper.players.nfl.v1";
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000;

async function getPlayers() {
  try {
    const raw = localStorage.getItem(PLAYER_CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < PLAYER_CACHE_TTL) return data;
    }
  } catch (_) { /* fall through */ }

  const data = await api("/players/nfl");
  try {
    localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {
    // Quota exceeded — that's fine, we still return the fresh data.
  }
  return data;
}

/* ---- Core league fetches ---- */
const getState    = ()     => api("/state/nfl");
const getLeague   = (id=LEAGUE_ID) => api(`/league/${id}`);
const getUsers    = (id=LEAGUE_ID) => api(`/league/${id}/users`);
const getRosters  = (id=LEAGUE_ID) => api(`/league/${id}/rosters`);
const getMatchups = (week, id=LEAGUE_ID) => api(`/league/${id}/matchups/${week}`);
const getTransactions = (week, id=LEAGUE_ID) => api(`/league/${id}/transactions/${week}`);
const getWinnersBracket = (id=LEAGUE_ID) => api(`/league/${id}/winners_bracket`);

/* Build a lookup: roster_id → { user, roster } */
function buildTeamMap(users, rosters) {
  const usersById = new Map(users.map(u => [u.user_id, u]));
  const map = new Map();
  rosters.forEach(r => {
    const u = usersById.get(r.owner_id) || {};
    map.set(r.roster_id, {
      roster_id: r.roster_id,
      user_id: r.owner_id,
      display_name: u.display_name || `Team ${r.roster_id}`,
      team_name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
      avatar: u.metadata && u.metadata.avatar
        ? u.metadata.avatar
        : (u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null),
      wins:   r.settings ? r.settings.wins   : 0,
      losses: r.settings ? r.settings.losses : 0,
      ties:   r.settings ? r.settings.ties   : 0,
      fpts:   r.settings ? (r.settings.fpts + (r.settings.fpts_decimal || 0) / 100) : 0,
      fpts_against: r.settings ? (r.settings.fpts_against + (r.settings.fpts_against_decimal || 0) / 100) : 0,
      players: r.players || [],
      starters: r.starters || [],
    });
  });
  return map;
}

/* Power rankings: 5-factor formula
   - 35% Points For percentile (actual scoring ability)
   - 25% Roster Strength (sum of starting ROS projections — future-facing)
   - 20% Recent Form (last 3 weeks avg vs season avg)
   - 10% Points Against percentile (luck adjustment — teams that faced tough schedules get credit)
   - 10% All-Play Win Rate (would you beat median opponent? removes head-to-head luck)

   Pre-Week-1 fallback: when no games played, uses roster strength only + neutral defaults.
*/
async function computePowerRankings(teams, currentWeek, rosterStrengths = null) {
  const arr = Array.from(teams.values());
  const n = arr.length;
  if (n === 0) return [];

  const gamesPlayed = arr[0]?.wins + arr[0]?.losses + arr[0]?.ties || 0;

  // === PRE-SEASON MODE ===
  // No games played yet — power rank on roster strength alone (if available)
  if (gamesPlayed === 0) {
    return arr
      .map(t => {
        const rosterStrength = rosterStrengths?.get(t.roster_id) ?? 100;
        // Normalize to 0-100 scale based on league min/max
        return { ...t, power: rosterStrength, form: 1.0, allPlayWins: 0, allPlayLosses: 0, rosterStrength };
      })
      .sort((a, b) => b.power - a.power);
  }

  // === IN-SEASON MODE ===
  // Points-for percentile (35%)
  const sortedByFpts = [...arr].sort((a, b) => b.fpts - a.fpts);
  const fptsRank = new Map(sortedByFpts.map((t, i) => [t.roster_id, i]));

  // Points-against percentile (10%) — HIGHER points against = HARDER schedule
  const sortedByPa = [...arr].sort((a, b) => b.fpts_against - a.fpts_against);
  const paRank = new Map(sortedByPa.map((t, i) => [t.roster_id, i]));

  // Recent form: last 3 weeks avg vs season avg (20%)
  const recentWeeks = [];
  for (let w = Math.max(1, currentWeek - 3); w < currentWeek; w++) {
    recentWeeks.push(w);
  }

  const recentAvg = new Map();
  const weeklyScores = []; // for all-play calculation
  for (const w of Math.max(1, currentWeek - 17) <= currentWeek - 1
                  ? Array.from({length: currentWeek - 1}, (_, i) => i + 1)
                  : []) {
    try {
      const m = await getMatchups(w);
      m.forEach(entry => {
        // Track weekly scores for all-play
        weeklyScores.push({ week: w, roster_id: entry.roster_id, points: entry.points || 0 });
        // Recent form tracking
        if (recentWeeks.includes(w)) {
          const cur = recentAvg.get(entry.roster_id) || { total: 0, n: 0 };
          cur.total += entry.points || 0;
          cur.n += 1;
          recentAvg.set(entry.roster_id, cur);
        }
      });
    } catch (_) { /* week may not exist */ }
  }

  // Compute all-play records (would you beat every other team each week?)
  const allPlayRecords = new Map();
  const weeksPlayed = [...new Set(weeklyScores.map(s => s.week))];
  for (const week of weeksPlayed) {
    const weekScores = weeklyScores.filter(s => s.week === week);
    // Skip weeks where nobody scored (not yet played)
    if (weekScores.every(s => s.points === 0)) continue;

    for (const teamScore of weekScores) {
      const rec = allPlayRecords.get(teamScore.roster_id) || { wins: 0, losses: 0, ties: 0 };
      for (const opp of weekScores) {
        if (opp.roster_id === teamScore.roster_id) continue;
        if (teamScore.points > opp.points) rec.wins++;
        else if (teamScore.points < opp.points) rec.losses++;
        else rec.ties++;
      }
      allPlayRecords.set(teamScore.roster_id, rec);
    }
  }

  return arr
    .map(t => {
      const games = t.wins + t.losses + t.ties;
      const seasonAvg = games > 0 ? t.fpts / games : 0;

      // Signal 1: Points For percentile (0-1)
      const fptsScore = 1 - (fptsRank.get(t.roster_id) || 0) / Math.max(n - 1, 1);

      // Signal 2: Roster Strength (from consensus projections, normalized to league min/max)
      const rosterStrength = rosterStrengths?.get(t.roster_id) ?? null;
      let rosterScore = 0.5; // default neutral if no data
      if (rosterStrengths && rosterStrengths.size > 0) {
        const strengths = Array.from(rosterStrengths.values());
        const maxRS = Math.max(...strengths);
        const minRS = Math.min(...strengths);
        const range = maxRS - minRS;
        if (range > 0 && rosterStrength != null) {
          rosterScore = (rosterStrength - minRS) / range;
        }
      }

      // Signal 3: Recent Form (last 3 weeks avg / season avg, capped)
      const recent = recentAvg.get(t.roster_id);
      const recentAvgVal = recent && recent.n > 0 ? recent.total / recent.n : seasonAvg;
      const formRatio = seasonAvg > 0 ? recentAvgVal / seasonAvg : 1;
      const formScore = Math.max(0, Math.min(1, (formRatio - 0.7) / 0.6)); // 0.7 → 0, 1.3 → 1

      // Signal 4: Points Against percentile (0-1, higher = tougher schedule = MORE credit)
      const paScore = 1 - (paRank.get(t.roster_id) || 0) / Math.max(n - 1, 1);

      // Signal 5: All-play win rate
      const allPlay = allPlayRecords.get(t.roster_id) || { wins: 0, losses: 0, ties: 0 };
      const allPlayGames = allPlay.wins + allPlay.losses + allPlay.ties;
      const allPlayScore = allPlayGames > 0
        ? (allPlay.wins + 0.5 * allPlay.ties) / allPlayGames
        : 0.5;

      // Weighted composite
      const power =
        (fptsScore * 35) +
        (rosterScore * 25) +
        (formScore * 20) +
        (paScore * 10) +
        (allPlayScore * 10);

      return {
        ...t,
        power,
        form: formRatio,
        allPlayWins: allPlay.wins,
        allPlayLosses: allPlay.losses,
        allPlayTies: allPlay.ties,
        rosterStrength: rosterStrength,
        // For display / tooltip
        fptsScore,
        rosterScore,
        formScore,
        paScore,
        allPlayScore,
      };
    })
    .sort((a, b) => b.power - a.power);
}

/* Load the slim Sleeper player DB (produced weekly by GH Actions).
   Falls back to null if the file isn't there yet. */
async function getSleeperPlayers() {
  try {
    const res = await fetch("assets/data/sleeper-players.json", { cache: "default" });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

/* Build enriched teams (via buildTeamMap) but also attach each team's
   roster of player names, cross-referenced from the Sleeper players DB.
   Returns the same Map but with `.roster_names` on each team. */
async function buildTeamsWithRosters() {
  const [users, rosters, sleeperPlayers] = await Promise.all([
    getUsers(),
    getRosters(),
    getSleeperPlayers(),
  ]);
  const teams = buildTeamMap(users, rosters);
  const dbPlayers = sleeperPlayers?.players || {};

  // Match each roster's Sleeper player_ids to names
  rosters.forEach(r => {
    const team = teams.get(r.roster_id);
    if (!team) return;
    const names = [];
    (r.players || []).forEach(pid => {
      const p = dbPlayers[pid];
      if (p && p.name) names.push({ name: p.name, pos: p.pos, team: p.team });
    });
    team.roster_names = names;
  });

  return teams;
}

window.Sleeper = {
  LEAGUE_ID, getState, getLeague, getUsers, getRosters,
  getMatchups, getTransactions, getWinnersBracket,
  getPlayers, buildTeamMap, computePowerRankings,
  getSleeperPlayers, buildTeamsWithRosters,
};
