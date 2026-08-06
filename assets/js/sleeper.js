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

/* Power rankings: wins × record weight + points-for percentile + recent form */
async function computePowerRankings(teams, currentWeek) {
  const arr = Array.from(teams.values());
  const n = arr.length;
  if (n === 0) return [];

  // Points-for percentile ranking
  const sortedByFpts = [...arr].sort((a, b) => b.fpts - a.fpts);
  const fptsRank = new Map(sortedByFpts.map((t, i) => [t.roster_id, i]));

  // Recent form: last 3 weeks avg vs season avg
  const recentWeeks = [];
  for (let w = Math.max(1, currentWeek - 3); w < currentWeek; w++) {
    recentWeeks.push(w);
  }
  const recentAvg = new Map();  // roster_id → recent points avg
  for (const w of recentWeeks) {
    try {
      const m = await getMatchups(w);
      m.forEach(entry => {
        const cur = recentAvg.get(entry.roster_id) || { total: 0, n: 0 };
        cur.total += entry.points || 0;
        cur.n += 1;
        recentAvg.set(entry.roster_id, cur);
      });
    } catch (_) { /* week may not exist */ }
  }

  return arr
    .map(t => {
      const games = t.wins + t.losses + t.ties;
      const winPct = games > 0 ? (t.wins + 0.5 * t.ties) / games : 0.5;
      const fptsScore = 1 - (fptsRank.get(t.roster_id) || 0) / Math.max(n - 1, 1);
      const seasonAvg = games > 0 ? t.fpts / games : 0;
      const recent = recentAvg.get(t.roster_id);
      const recentAvgVal = recent && recent.n > 0 ? recent.total / recent.n : seasonAvg;
      const form = seasonAvg > 0 ? recentAvgVal / seasonAvg : 1;

      const power = (winPct * 60) + (fptsScore * 25) + (Math.min(form, 1.5) / 1.5 * 15);
      return { ...t, power, form };
    })
    .sort((a, b) => b.power - a.power);
}

window.Sleeper = {
  LEAGUE_ID, getState, getLeague, getUsers, getRosters,
  getMatchups, getTransactions, getWinnersBracket,
  getPlayers, buildTeamMap, computePowerRankings,
};
