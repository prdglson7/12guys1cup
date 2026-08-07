/**
 * Fetches Draft Kit data (consensus rankings + ADP) from FantasyPros
 * and writes to assets/data/draftkit.json.
 *
 * Run by .github/workflows/update-draftkit.yml every 8 hours.
 *
 * API budget:
 *   8 calls per run × 3 runs/day = 24 calls/day
 *   Plus news workflow (24/day) = 48 total, under 50/day free tier limit.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const FP_KEY = process.env.FANTASYPROS_API_KEY;
const SEASON = process.env.FP_SEASON || new Date().getFullYear().toString();

if (!FP_KEY) {
  console.error('FANTASYPROS_API_KEY secret not set.');
  process.exit(1);
}

console.log(`Fetching Draft Kit data for season ${SEASON}`);

function fetchJson(url, label) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'x-api-key': FP_KEY,
        'Accept': 'application/json',
      },
      timeout: 15000,
    };
    https.get(url, opts, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function fetchRanking(position, scoring) {
  const label = `[${position}/${scoring}]`;
  const url = `${FP_BASE}/nfl/${SEASON}/consensus-rankings?position=${position}&scoring=${scoring}&experts=show`;
  try {
    const data = await fetchJson(url, label);
    const players = (data.players || []).map(p => ({
      player_id: p.player_id,
      name: p.player_name,
      short_name: p.player_short_name,
      pos: p.player_position_id,
      team: p.player_team_id,
      bye: p.player_bye_week,
      rank: p.rank_ecr,
      pos_rank: p.pos_rank,
      tier: p.tier,
      owned_avg: p.player_owned_avg,
      page_url: p.player_page_url,
    }));
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
    const data = await fetchJson(url, label);
    const players = (data.players || []).map(p => ({
      player_id: p.player_id || p.id,
      name: p.player_name || p.name,
      pos: p.player_position_id || p.position_id,
      team: p.player_team_id || p.team_id,
      adp: p.rank_adp || p.rank,
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

  // Fire position-specific rankings + ADP in parallel.
  // The ALL/OVERALL endpoint returns HTTP 400 on the free tier, so we skip it
  // and build "overall" by merging the position lists ourselves.
  const [qb, rb, wr, te, k, dst, adp] = await Promise.all([
    fetchRanking('QB',  'PPR'),
    fetchRanking('RB',  'PPR'),
    fetchRanking('WR',  'PPR'),
    fetchRanking('TE',  'PPR'),
    fetchRanking('K',   'STD'),
    fetchRanking('DST', 'STD'),
    fetchAdp(),
  ]);

  // Build overall by merging positions and sorting by ECR rank
  const overallPlayers = [
    ...qb.players, ...rb.players, ...wr.players,
    ...te.players, ...k.players,  ...dst.players,
  ]
    .filter(p => p.rank != null)
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));

  const out = {
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    season: SEASON,
    scoring_default: 'PPR',
    _note: 'Free tier caps position rankings at ~10 players. Overall is built from merged positions.',
    rankings: {
      overall: overallPlayers,
      QB: qb.players,
      RB: rb.players,
      WR: wr.players,
      TE: te.players,
      K:  k.players,
      DST: dst.players,
    },
    adp: adp.players,
    _summary: {
      overall: overallPlayers.length,
      QB: qb.players.length,
      RB: rb.players.length,
      WR: wr.players.length,
      TE: te.players.length,
      K: k.players.length,
      DST: dst.players.length,
      adp: adp.players.length,
    },
  };

  const outPath = 'assets/data/draftkit.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`Wrote ${outPath}`);
  console.log(`Season ${SEASON}, ${Date.now() - started}ms`);
  console.log(`Summary:`, JSON.stringify(out._summary));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
