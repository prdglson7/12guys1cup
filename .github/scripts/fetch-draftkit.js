/**
 * Fetches Draft Kit data from FantasyPros HOF tier.
 * With HOF: full-depth rankings (50+/pos), season projections, ADP.
 *
 * Total per run:
 *   6 rankings + 4 projections (skill only) + 1 ADP = 11 calls
 *   Runs every 6 hours = 44 calls/day
 *
 * Combined with news+injuries workflow (48/day) = 92/day total.
 * HOF rate limit is comfortably above this.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const FP_KEY = process.env.FANTASYPROS_API_KEY;
const SEASON = process.env.FP_SEASON || '2026';
const SCORING = process.env.FP_SCORING || 'PPR';   // Full PPR — user's league

if (!FP_KEY) {
  console.error('FANTASYPROS_API_KEY secret not set.');
  process.exit(1);
}

console.log(`Fetching Draft Kit — season ${SEASON}, scoring ${SCORING}`);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'x-api-key': FP_KEY,
        'Accept': 'application/json',
      },
      timeout: 20000,
    };
    https.get(url, opts, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

async function fetchRanking(position, scoring) {
  const label = `[Rank ${position}/${scoring}]`;
  const url = `${FP_BASE}/nfl/${SEASON}/consensus-rankings?position=${position}&scoring=${scoring}&experts=show`;
  try {
    const data = await fetchJson(url);
    const players = (data.players || []).map(p => ({
      player_id: p.player_id,
      name: p.player_name,
      short_name: p.player_short_name,
      pos: p.player_position_id,
      team: p.player_team_id,
      bye: p.player_bye_week,
      rank: num(p.rank_ecr),
      pos_rank: p.pos_rank,
      tier: num(p.tier),
      // Actual FP field names — my earlier version guessed wrong
      best_rank: num(p.rank_min),
      worst_rank: num(p.rank_max),
      avg_rank: num(p.rank_ave),
      std_dev: num(p.rank_std),
      owned_avg: num(p.player_owned_avg),
      owned_espn: num(p.player_owned_espn),
      owned_yahoo: num(p.player_owned_yahoo),
      ecr_delta: num(p.player_ecr_delta),
      page_url: p.player_page_url,
    }));
    console.log(`${label} ✓ ${players.length} players`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [], error: e.message };
  }
}

async function fetchProjections(position, scoring) {
  const label = `[Proj ${position}/${scoring}]`;
  const url = `${FP_BASE}/nfl/${SEASON}/projections?position=${position}&scoring=${scoring}&week=0`;
  try {
    const data = await fetchJson(url);
    const players = (data.players || []).map(p => {
      const stats = p.stats || {};
      return {
        player_id: p.player_id,
        name: p.player_name,
        pos: p.player_position_id,
        pts: num(p.fantasy_pts || stats.fantasy_pts || stats.points),
        pass_yds: num(stats.pass_yds),
        pass_tds: num(stats.pass_tds),
        rush_yds: num(stats.rush_yds),
        rush_tds: num(stats.rush_tds),
        rec: num(stats.rec),
        rec_yds: num(stats.rec_yds),
        rec_tds: num(stats.rec_tds),
      };
    });
    console.log(`${label} ✓ ${players.length} players`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [], error: e.message };
  }
}

async function fetchAdp() {
  const label = '[ADP]';
  const url = `${FP_BASE}/nfl/${SEASON}/rankings?type=ADP&range=true`;
  try {
    const data = await fetchJson(url);
    const players = (data.players || []).map(p => ({
      player_id: p.player_id || p.id,
      name: p.player_name || p.name,
      pos: p.player_position_id || p.position_id,
      team: p.player_team_id || p.team_id,
      adp: num(p.rank_adp || p.rank),
      adp_low: num(p.rank_adp_low),
      adp_high: num(p.rank_adp_high),
    }));
    console.log(`${label} ✓ ${players.length} players`);
    return { ok: true, players };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, players: [], error: e.message };
  }
}

async function main() {
  const started = Date.now();

  // Fire everything in parallel
  const [qb, rb, wr, te, k, dst, projQb, projRb, projWr, projTe, adp] = await Promise.all([
    fetchRanking('QB',  SCORING),
    fetchRanking('RB',  SCORING),
    fetchRanking('WR',  SCORING),
    fetchRanking('TE',  SCORING),
    fetchRanking('K',   'STD'),
    fetchRanking('DST', 'STD'),
    fetchProjections('QB', SCORING),
    fetchProjections('RB', SCORING),
    fetchProjections('WR', SCORING),
    fetchProjections('TE', SCORING),
    fetchAdp(),
  ]);

  // Merge projections and ADP into rankings by player name
  const projByName = new Map();
  [projQb, projRb, projWr, projTe].forEach(res => {
    res.players.forEach(p => {
      if (p.name) projByName.set(p.name.toLowerCase(), p);
    });
  });

  const adpByName = new Map();
  adp.players.forEach(p => { if (p.name) adpByName.set(p.name.toLowerCase(), p); });

  const enrich = (players) => players.map(p => {
    const key = (p.name || '').toLowerCase();
    const proj = projByName.get(key);
    const a = adpByName.get(key);
    return {
      ...p,
      proj_pts: proj ? proj.pts : null,
      proj_stats: proj ? {
        pass_yds: proj.pass_yds, pass_tds: proj.pass_tds,
        rush_yds: proj.rush_yds, rush_tds: proj.rush_tds,
        rec: proj.rec, rec_yds: proj.rec_yds, rec_tds: proj.rec_tds,
      } : null,
      adp: a ? a.adp : null,
      adp_low: a ? a.adp_low : null,
      adp_high: a ? a.adp_high : null,
    };
  });

  const rankings = {
    QB:  enrich(qb.players),
    RB:  enrich(rb.players),
    WR:  enrich(wr.players),
    TE:  enrich(te.players),
    K:   enrich(k.players),
    DST: enrich(dst.players),
  };

  const overall = [
    ...rankings.QB, ...rankings.RB, ...rankings.WR,
    ...rankings.TE, ...rankings.K, ...rankings.DST,
  ]
    .filter(p => p.rank != null)
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));

  const out = {
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    season: SEASON,
    scoring: SCORING,
    rankings: {
      overall,
      ...rankings,
    },
    _summary: {
      overall: overall.length,
      QB: rankings.QB.length,
      RB: rankings.RB.length,
      WR: rankings.WR.length,
      TE: rankings.TE.length,
      K: rankings.K.length,
      DST: rankings.DST.length,
      adp: adp.players.length,
    },
  };

  const outPath = 'assets/data/draftkit.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`Wrote ${outPath}`);
  console.log(`Season ${SEASON} • ${SCORING} • ${Date.now() - started}ms`);
  console.log(`Summary:`, JSON.stringify(out._summary));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
