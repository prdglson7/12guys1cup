/**
 * Posts live matchup scores to Discord.
 * Runs during game windows in-season only.
 */
const https = require('https');
const { postToDiscord, isInSeason, COLORS } = require('./discord-lib');

const WEBHOOK = process.env.DISCORD_SCORES_WEBHOOK;
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID || '1389753693590532096';

if (!WEBHOOK) {
  console.log('DISCORD_SCORES_WEBHOOK not set — skipping.');
  process.exit(0);
}

if (!isInSeason()) {
  console.log('Offseason — skipping score updates.');
  process.exit(0);
}

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
  // Get NFL state (current week)
  const state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
  const week = state.week;
  if (!week || week < 1 || week > 17) {
    console.log(`Not in a regular-season week (week=${week}) — skipping.`);
    return;
  }
  console.log(`Current week: ${week}`);

  // League info + rosters + users
  const [league, rosters, users, matchups] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${week}`),
  ]);

  // Build team map: roster_id -> team_name
  const userById = new Map(users.map(u => [u.user_id, u]));
  const teams = new Map();
  rosters.forEach(r => {
    const u = userById.get(r.owner_id) || {};
    const name = (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`;
    teams.set(r.roster_id, { name, roster_id: r.roster_id });
  });

  // Pair matchups by matchup_id
  const byPair = new Map();
  matchups.forEach(m => {
    if (!m.matchup_id) return;
    if (!byPair.has(m.matchup_id)) byPair.set(m.matchup_id, []);
    byPair.get(m.matchup_id).push(m);
  });

  const pairs = Array.from(byPair.values()).filter(p => p.length === 2);
  if (!pairs.length) {
    console.log('No paired matchups yet — schedule not set.');
    return;
  }

  // Only post if there's actual scoring happening
  const hasScoring = matchups.some(m => (m.points || 0) > 0.1);
  if (!hasScoring) {
    console.log('No scoring yet — skipping post.');
    return;
  }

  // Build embed lines
  const rows = pairs.map(([a, b]) => {
    const tA = teams.get(a.roster_id) || { name: '?' };
    const tB = teams.get(b.roster_id) || { name: '?' };
    const pA = (a.points || 0).toFixed(1);
    const pB = (b.points || 0).toFixed(1);
    const winMarker = (pA - pB > 0.05) ? '←' : (pB - pA > 0.05) ? '→' : ' ';
    return `\`${pA.padStart(6)}\` ${winMarker} ${tA.name}  **vs**  ${tB.name} ${winMarker === '→' ? '←' : winMarker === '←' ? '→' : ' '} \`${pB.padStart(6)}\``;
  });

  const embed = {
    title: `Week ${week} — Live Scoreboard`,
    description: rows.join('\n'),
    color: COLORS.navy,
    footer: { text: `12guys1cup • ${new Date().toUTCString().slice(0, 22)} UTC` },
  };

  await postToDiscord(WEBHOOK, { embeds: [embed] });
  console.log(`Posted Week ${week} scores (${pairs.length} matchups).`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
