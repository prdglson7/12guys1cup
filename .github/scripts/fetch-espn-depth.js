/**
 * ESPN Depth Chart + Injury Fetcher (v2 - fixed API paths)
 *
 * Uses ESPN's core API which has more reliable structure than the site API.
 *
 * Depth chart endpoint (per team, per year):
 *   http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{year}/teams/{teamId}/depthcharts
 *
 * Injuries endpoint (per team):
 *   https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/{teamAbbr}/injuries
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(REPO_ROOT, 'assets', 'data', 'espn-depth-charts.json');
const SEASON = new Date().getFullYear();

const TEAMS = [
  { espnId: '22', abbr: 'ARI' }, { espnId: '1',  abbr: 'ATL' },
  { espnId: '33', abbr: 'BAL' }, { espnId: '2',  abbr: 'BUF' },
  { espnId: '29', abbr: 'CAR' }, { espnId: '3',  abbr: 'CHI' },
  { espnId: '4',  abbr: 'CIN' }, { espnId: '5',  abbr: 'CLE' },
  { espnId: '6',  abbr: 'DAL' }, { espnId: '7',  abbr: 'DEN' },
  { espnId: '8',  abbr: 'DET' }, { espnId: '9',  abbr: 'GB'  },
  { espnId: '34', abbr: 'HOU' }, { espnId: '11', abbr: 'IND' },
  { espnId: '30', abbr: 'JAX' }, { espnId: '12', abbr: 'KC'  },
  { espnId: '24', abbr: 'LAC' }, { espnId: '14', abbr: 'LAR' },
  { espnId: '13', abbr: 'LV'  }, { espnId: '15', abbr: 'MIA' },
  { espnId: '16', abbr: 'MIN' }, { espnId: '17', abbr: 'NE'  },
  { espnId: '18', abbr: 'NO'  }, { espnId: '19', abbr: 'NYG' },
  { espnId: '20', abbr: 'NYJ' }, { espnId: '21', abbr: 'PHI' },
  { espnId: '23', abbr: 'PIT' }, { espnId: '26', abbr: 'SEA' },
  { espnId: '25', abbr: 'SF'  }, { espnId: '27', abbr: 'TB'  },
  { espnId: '10', abbr: 'TEN' }, { espnId: '28', abbr: 'WAS' },
];

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/* Fetch depth chart using CORE API. Athletes are $ref links needing resolution. */
async function fetchTeamDepth(espnId, abbr) {
  const url = `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${SEASON}/teams/${espnId}/depthcharts`;
  try {
    const data = await fetchJson(url);
    return await parseDepthChartCoreApi(data);
  } catch (e) {
    console.log(`  ✗ ${abbr}: depth ${e.message}`);
    return null;
  }
}

/* Athletes come as { athlete: {$ref: "..."}, rank: 1 } — resolve refs to get names. */
async function parseDepthChartCoreApi(data) {
  const result = { QB: [], RB: [], WR: [], TE: [] };

  const items = data.items || [];
  if (items.length === 0) return result;

  const offense = items.find(i => (i.name || '').toLowerCase().includes('offense')) || items[0];
  if (!offense) return result;

  const positions = offense.positions || {};

  // Collect all athlete refs first (parallel resolve later)
  const refsToResolve = [];
  for (const [posKey, posData] of Object.entries(positions)) {
    const normPos = normalizePos(posKey);
    if (!normPos || !result[normPos]) continue;
    const athletes = posData.athletes || [];
    for (const athEntry of athletes) {
      const rank = athEntry.rank || 999;
      const athleteRef = athEntry.athlete?.$ref;
      if (!athleteRef) continue;
      refsToResolve.push({ pos: normPos, rank, ref: athleteRef });
    }
  }

  // Resolve in parallel batches of 10
  const BATCH = 10;
  for (let i = 0; i < refsToResolve.length; i += BATCH) {
    const batch = refsToResolve.slice(i, i + BATCH);
    const resolved = await Promise.all(batch.map(async item => {
      try {
        const athData = await fetchJson(item.ref);
        return {
          ...item,
          name: athData.fullName || athData.displayName,
          espnId: athData.id,
        };
      } catch (e) {
        return null;
      }
    }));
    for (const r of resolved) {
      if (r?.name) {
        result[r.pos].push({ name: r.name, rank: r.rank, espnId: r.espnId });
      }
    }
  }

  // Sort by rank and dedupe
  for (const pos of Object.keys(result)) {
    result[pos].sort((a, b) => a.rank - b.rank);
    const seen = new Set();
    result[pos] = result[pos].filter(p => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  }

  return result;
}

async function fetchTeamInjuries(abbr) {
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/${abbr}/injuries`;
  try {
    const data = await fetchJson(url);
    return parseInjuries(data);
  } catch (e) {
    console.log(`  ✗ ${abbr}: injuries ${e.message}`);
    return {};
  }
}

function parseInjuries(data) {
  const result = {};
  const injuries = data.injuries || [];
  for (const inj of injuries) {
    const athlete = inj.athlete;
    if (!athlete) continue;
    const name = athlete.displayName || athlete.fullName;
    if (!name) continue;
    const status = inj.status || inj.type?.description;
    if (!status) continue;
    result[normalizeName(name)] = {
      name,
      status: normalizeStatus(status),
      description: inj.longComment || inj.shortComment || null,
    };
  }
  return result;
}

function normalizePos(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (c === 'QB' || c.includes('QUARTERBACK')) return 'QB';
  if (['RB', 'HB', 'FB', 'TB'].includes(c) || c.includes('RUNNING')) return 'RB';
  if (['WR', 'LWR', 'RWR', 'SWR', 'X', 'Z', 'SLOT'].includes(c) || c.includes('RECEIVER')) return 'WR';
  if (['TE', 'LTE', 'RTE', 'Y'].includes(c) || c.includes('TIGHT')) return 'TE';
  return null;
}

function normalizeStatus(status) {
  const s = String(status).toLowerCase();
  if (s.includes('injured reserve') || s === 'ir') return 'IR';
  if (s.includes('out')) return 'Out';
  if (s.includes('doubtful')) return 'Doubtful';
  if (s.includes('questionable')) return 'Questionable';
  if (s.includes('suspend')) return 'Suspended';
  if (s.includes('probable')) return 'Probable';
  if (s.includes('pup') || s.includes('physically')) return 'PUP';
  return status;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  console.log(`Fetching ESPN depth charts + injuries for ${SEASON} season…`);
  const started = Date.now();

  const teams = {};
  const allInjuries = {};

  for (const { espnId, abbr } of TEAMS) {
    const injuries = await fetchTeamInjuries(abbr);
    const depth = await fetchTeamDepth(espnId, abbr);

    if (depth) {
      teams[abbr] = depth;
      const summary = `QB1=${depth.QB[0]?.name || '?'}, RB1=${depth.RB[0]?.name || '?'}, TE1=${depth.TE[0]?.name || '?'}`;
      console.log(`  ✓ ${abbr}: ${summary}`);
    }

    const injCount = Object.keys(injuries).length;
    if (injCount > 0) {
      const outNames = Object.entries(injuries)
        .filter(([_, v]) => ['Out', 'IR', 'Suspended', 'PUP'].includes(v.status))
        .map(([_, v]) => v.name);
      if (outNames.length > 0) {
        console.log(`     Injuries: ${injCount} listed, OUT: ${outNames.join(', ')}`);
      } else {
        console.log(`     Injuries: ${injCount} listed (none out)`);
      }
    }

    for (const [name, inj] of Object.entries(injuries)) {
      allInjuries[name] = { ...inj, team: abbr };
    }

    await new Promise(r => setTimeout(r, 100));
  }

  const outCount = Object.values(allInjuries).filter(i =>
    ['Out', 'IR', 'Suspended', 'PUP'].includes(i.status)
  ).length;

  const output = {
    fetched_at: new Date().toISOString(),
    team_count: Object.keys(teams).length,
    injury_count: Object.keys(allInjuries).length,
    out_count: outCount,
    duration_ms: Date.now() - started,
    teams,
    injuries: allInjuries,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

  console.log(`\nWrote ${OUTPUT}`);
  console.log(`Teams with depth data: ${Object.keys(teams).length}/32`);
  console.log(`Total injuries: ${Object.keys(allInjuries).length}`);
  console.log(`OUT/IR/Suspended/PUP: ${outCount}`);
  console.log(`Duration: ${output.duration_ms}ms`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
