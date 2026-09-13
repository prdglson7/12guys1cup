/**
 * ESPN Depth Chart + Injury Fetcher
 *
 * Fetches real-time depth charts and injury reports from ESPN's public API
 * for all 32 NFL teams. Writes to assets/data/espn-depth-charts.json.
 *
 * Runs every 30 min via workflow. ESPN updates depth charts when coaches
 * publish them (usually Wed/Thu practice reports).
 *
 * No API key required.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(REPO_ROOT, 'assets', 'data', 'espn-depth-charts.json');

// ESPN team IDs (their internal IDs, not abbreviations)
// Format: { espnId: sleeperAbbr }
const ESPN_TEAM_IDS = {
  '22': 'ARI', '1':  'ATL', '33': 'BAL', '2':  'BUF',
  '29': 'CAR', '3':  'CHI', '4':  'CIN', '5':  'CLE',
  '6':  'DAL', '7':  'DEN', '8':  'DET', '9':  'GB',
  '34': 'HOU', '11': 'IND', '30': 'JAX', '12': 'KC',
  '24': 'LAC', '14': 'LAR', '13': 'LV',  '15': 'MIA',
  '16': 'MIN', '17': 'NE',  '18': 'NO',  '19': 'NYG',
  '20': 'NYJ', '21': 'PHI', '23': 'PIT', '26': 'SEA',
  '25': 'SF',  '27': 'TB',  '10': 'TEN', '28': 'WAS',
};

const OFFENSIVE_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/* Fetch depth chart for one team */
async function fetchTeamDepth(espnId, abbr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${espnId}/depthchart`;
  try {
    const data = await fetchJson(url);
    return parseDepthChart(data, abbr);
  } catch (e) {
    console.log(`  ✗ ${abbr}: depth ${e.message}`);
    return null;
  }
}

/* Fetch injuries for one team */
async function fetchTeamInjuries(espnId, abbr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${espnId}/injuries`;
  try {
    const data = await fetchJson(url);
    return parseInjuries(data, abbr);
  } catch (e) {
    console.log(`  ✗ ${abbr}: injuries ${e.message}`);
    return {};
  }
}

/* Parse ESPN depth chart response
   Structure: { items: [ { name: "Offense", positions: { QB: { positions: { athletes: [...] } } } } ] }
*/
function parseDepthChart(data, abbr) {
  const result = { QB: [], RB: [], WR: [], TE: [] };

  const items = data.items || [];
  const offense = items.find(i => (i.name || '').toLowerCase().includes('offense'));
  if (!offense) return result;

  const positions = offense.positions || {};

  // ESPN groups by position code — QB, RB, WR, TE, LWR, RWR, etc.
  for (const [posKey, posData] of Object.entries(positions)) {
    const normalizedPos = normalizePos(posKey);
    if (!normalizedPos) continue;

    const athletes = posData.athletes || posData.items || [];
    // Athletes come sorted by depth (rank field)
    athletes.forEach((a, idx) => {
      const athlete = a.athlete || a;
      const name = athlete.displayName || athlete.fullName || athlete.name;
      if (!name) return;

      result[normalizedPos].push({
        name,
        rank: a.rank || idx + 1,
        espnId: athlete.id || null,
        // ESPN sometimes includes status inline
        status: a.status || null,
      });
    });
  }

  // Sort by rank ascending (starter = rank 1)
  for (const pos of Object.keys(result)) {
    result[pos].sort((a, b) => a.rank - b.rank);
  }

  // Dedupe: same player might appear at multiple WR positions (X, Z, slot)
  for (const pos of ['WR']) {
    const seen = new Set();
    result[pos] = result[pos].filter(p => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  }

  return result;
}

/* Normalize ESPN position codes */
function normalizePos(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (c === 'QB') return 'QB';
  if (['RB', 'HB', 'FB', 'TB'].includes(c)) return 'RB';
  if (['WR', 'LWR', 'RWR', 'SWR', 'X', 'Z', 'SLOT'].includes(c)) return 'WR';
  if (['TE', 'LTE', 'RTE', 'Y'].includes(c)) return 'TE';
  return null;
}

/* Parse ESPN injuries response
   Structure: { injuries: [ { athlete: {...}, status: "Out", details: {...} } ] }
   Returns: { normalizedName: { status, description } }
*/
function parseInjuries(data, abbr) {
  const result = {};
  const injuries = data.injuries || [];

  // Response might be nested under athletes
  const list = injuries.length > 0 ? injuries :
    (data.athletes || []).flatMap(a => (a.items || []).map(item => ({ athlete: a.athlete, ...item })));

  list.forEach(inj => {
    const athlete = inj.athlete;
    if (!athlete) return;
    const name = athlete.displayName || athlete.fullName || athlete.name;
    if (!name) return;

    const status = inj.status || inj.type?.description || inj.details?.type || null;
    // ESPN statuses: "Active", "Questionable", "Doubtful", "Out", "Injured Reserve", "Suspended"
    if (!status) return;

    result[normalizeName(name)] = {
      name,
      status: normalizeStatus(status),
      description: inj.details?.detail || inj.longComment || inj.shortComment || null,
    };
  });

  return result;
}

/* Normalize ESPN injury status strings to standard values */
function normalizeStatus(status) {
  const s = String(status).toLowerCase();
  if (s.includes('out')) return 'Out';
  if (s.includes('injured reserve') || s === 'ir') return 'IR';
  if (s.includes('doubtful')) return 'Doubtful';
  if (s.includes('questionable')) return 'Questionable';
  if (s.includes('suspend')) return 'Suspended';
  if (s.includes('probable')) return 'Probable';
  if (s.includes('pup')) return 'PUP';
  return status; // Keep original if we don't recognize it
}

/* Normalize name for lookup (lowercase, no punctuation) */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Main */
async function main() {
  console.log('Fetching ESPN depth charts + injuries for all 32 teams…');
  const started = Date.now();

  const teams = {};
  const allInjuries = {}; // { normalizedName: { team, status, description } }

  const entries = Object.entries(ESPN_TEAM_IDS);

  // Sequential with small delays to be polite
  for (const [espnId, abbr] of entries) {
    const [depth, injuries] = await Promise.all([
      fetchTeamDepth(espnId, abbr),
      fetchTeamInjuries(espnId, abbr),
    ]);

    if (depth) {
      teams[abbr] = depth;
      const teDepth = depth.TE.length > 0 ? depth.TE[0].name : 'none';
      const rbDepth = depth.RB.length > 0 ? depth.RB[0].name : 'none';
      console.log(`  ✓ ${abbr}: QB1=${depth.QB[0]?.name || '?'}, RB1=${rbDepth}, TE1=${teDepth}`);
    }

    // Merge injuries with team context
    for (const [name, inj] of Object.entries(injuries)) {
      allInjuries[name] = { ...inj, team: abbr };
    }

    await new Promise(r => setTimeout(r, 150));
  }

  const output = {
    fetched_at: new Date().toISOString(),
    team_count: Object.keys(teams).length,
    injury_count: Object.keys(allInjuries).length,
    duration_ms: Date.now() - started,
    teams,       // { LV: { QB: [...], RB: [...], WR: [...], TE: [...] } }
    injuries: allInjuries, // { normalizedName: { name, team, status, description } }
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Teams: ${Object.keys(teams).length}, Injuries: ${Object.keys(allInjuries).length}, Duration: ${output.duration_ms}ms`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
