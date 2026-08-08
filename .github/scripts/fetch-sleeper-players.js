/**
 * Fetches Sleeper's players database (~5MB) and outputs a slim version
 * with only the fields we need for roster lookup (~500KB).
 *
 * Runs weekly. Committed to assets/data/sleeper-players.json.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const started = Date.now();
  console.log('Fetching Sleeper players DB…');
  const all = await fetchJson('https://api.sleeper.app/v1/players/nfl');
  const totalCount = Object.keys(all).length;
  console.log(`Loaded ${totalCount} players.`);

  // Filter to fantasy-relevant, active NFL players only
  const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
  const slim = {};
  let kept = 0;
  Object.entries(all).forEach(([id, p]) => {
    if (!p) return;
    if (!FANTASY_POSITIONS.has(p.position)) return;
    // Skip inactive/retired unless they have a fantasy positions match
    if (p.active === false && (!p.fantasy_positions || !p.fantasy_positions.length)) return;
    // Skip if no name at all
    const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
    if (!name) return;

    slim[id] = {
      name,
      pos: p.position,
      team: p.team || null,
      // Include years exp for context but keep it small
      years_exp: p.years_exp || 0,
    };
    kept++;
  });

  const out = {
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    total_available: totalCount,
    count: kept,
    players: slim,
  };

  const outPath = 'assets/data/sleeper-players.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`Wrote ${outPath} — ${kept} players, ${sizeKb}KB, ${out.duration_ms}ms`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
