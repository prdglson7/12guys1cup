/**
 * Posts weekly recap to Discord after MNF.
 * Runs Tuesday morning in-season.
 */
const https = require('https');
const { postToDiscord, isInSeason, COLORS } = require('./discord-lib');

const WEBHOOK = process.env.DISCORD_RECAP_WEBHOOK;
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID || '1389753693590532096';

if (!WEBHOOK) {
  console.log('DISCORD_RECAP_WEBHOOK not set — skipping.');
  process.exit(0);
}

if (!isInSeason()) {
  console.log('Offseason — skipping weekly recap.');
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
        catch (e) { reject(new Error('Bad JSON')); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
  // Recap the JUST-COMPLETED week (state.week is the CURRENT week; recap = previous week)
  const recapWeek = state.week - 1;
  if (recapWeek < 1 || recapWeek > 17) {
    console.log(`No week to recap (state.week=${state.week}).`);
    return;
  }
  console.log(`Recapping Week ${recapWeek}`);

  const [rosters, users, matchups] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${recapWeek}`),
  ]);

  const userById = new Map(users.map(u => [u.user_id, u]));
  const teams = new Map();
  rosters.forEach(r => {
    const u = userById.get(r.owner_id) || {};
    const name = (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`;
    teams.set(r.roster_id, {
      name,
      wins: r.settings?.wins || 0,
      losses: r.settings?.losses || 0,
      fpts: (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100,
    });
  });

  // Score analysis
  const scores = matchups
    .filter(m => (m.points || 0) > 0)
    .map(m => ({ roster_id: m.roster_id, points: m.points, matchup_id: m.matchup_id }))
    .sort((a, b) => b.points - a.points);

  if (!scores.length) {
    console.log('No scores recorded for that week — skipping.');
    return;
  }

  const highScorer = scores[0];
  const lowScorer = scores[scores.length - 1];
  const avg = scores.reduce((s, x) => s + x.points, 0) / scores.length;

  // Biggest blowout: pair up and find max margin
  const byPair = new Map();
  matchups.forEach(m => {
    if (!m.matchup_id) return;
    if (!byPair.has(m.matchup_id)) byPair.set(m.matchup_id, []);
    byPair.get(m.matchup_id).push(m);
  });
  const pairs = Array.from(byPair.values()).filter(p => p.length === 2);
  let biggestBlowout = null;
  let closestMatch = null;
  pairs.forEach(p => {
    const margin = Math.abs((p[0].points || 0) - (p[1].points || 0));
    if (!biggestBlowout || margin > biggestBlowout.margin) {
      biggestBlowout = { pair: p, margin };
    }
    if (!closestMatch || margin < closestMatch.margin) {
      closestMatch = { pair: p, margin };
    }
  });

  // Standings snapshot
  const ranked = Array.from(teams.values()).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.fpts - a.fpts;
  });

  // Build embed
  const lines = [];
  const highTeam = teams.get(highScorer.roster_id);
  const lowTeam = teams.get(lowScorer.roster_id);
  lines.push(`**High score:** ${highTeam?.name || '?'} — ${highScorer.points.toFixed(1)}`);
  lines.push(`**Low score:** ${lowTeam?.name || '?'} — ${lowScorer.points.toFixed(1)}`);
  lines.push(`**Average:** ${avg.toFixed(1)}`);
  lines.push('');

  if (biggestBlowout) {
    const [a, b] = biggestBlowout.pair;
    const winner = (a.points > b.points) ? a : b;
    const loser  = (a.points > b.points) ? b : a;
    lines.push(`**Blowout of the week:** ${teams.get(winner.roster_id)?.name} beat ${teams.get(loser.roster_id)?.name} by ${biggestBlowout.margin.toFixed(1)}`);
  }
  if (closestMatch && closestMatch.margin < 10) {
    const [a, b] = closestMatch.pair;
    lines.push(`**Nail-biter:** ${teams.get(a.roster_id)?.name} vs ${teams.get(b.roster_id)?.name} — decided by ${closestMatch.margin.toFixed(1)}`);
  }
  lines.push('');

  lines.push('**Standings:**');
  ranked.forEach((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${(i + 1).toString().padStart(2, ' ')}.`;
    lines.push(`${medal} **${t.name}** (${t.wins}-${t.losses}) — ${t.fpts.toFixed(1)} PF`);
  });

  const embed = {
    title: `Week ${recapWeek} Recap`,
    description: lines.join('\n').slice(0, 4000),
    color: COLORS.gold,
    footer: { text: '12guys1cup • Weekly Recap' },
    timestamp: new Date().toISOString(),
  };

  await postToDiscord(WEBHOOK, { embeds: [embed] });
  console.log(`Posted Week ${recapWeek} recap.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
