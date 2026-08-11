/**
 * Posts the weekly Studs & Duds Council ceremonies to Discord after MNF.
 * Runs Tuesday morning in-season via discord-recap.yml workflow.
 *
 * Three separate messages, 30-second delay between:
 *   1. His Grace (Coach of the Week)
 *   2. The Donkey (worst bench mistake by a losing team)
 *   3. The Peasant (lowest scorer of the week)
 *
 * Deduped via assets/data/discord-state.json (shame_last_week key).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { postToDiscord, isInSeason, COLORS } = require('./discord-lib');

const WEBHOOK = process.env.DISCORD_SHAME_WEBHOOK;
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID || '1389753693590532096';
const STATE_FILE = path.join(__dirname, '..', '..', 'assets', 'data', 'discord-state.json');
const MESSAGE_DELAY_MS = 30_000;

if (!WEBHOOK) {
  console.log('DISCORD_SHAME_WEBHOOK not set — skipping.');
  process.exit(0);
}

if (!isInSeason()) {
  console.log('Offseason — skipping Studs & Duds ceremonies.');
  process.exit(0);
}

// ------- Sleeper API helpers -------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON')); }
      });
    }).on('error', reject);
  });
}

// ------- State helpers (dedup) -------

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { console.log('State read failed, treating as empty:', e.message); }
  return {};
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.log('State write failed:', e.message); }
}

// ------- Sleep helper -------

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ------- Roman numerals (matches site) -------

function toRoman(num) {
  const romans = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII'];
  return romans[num] || String(num);
}

// ------- Shame algorithm — ported from pages.js renderShame() -------

/* Extract starting slots from league.roster_positions. */
function extractStartingSlots(rosterPositions) {
  const slots = {};
  (rosterPositions || []).forEach(pos => {
    if (['BN', 'IR', 'TAXI', 'RES'].includes(pos)) return;
    const key = (pos === 'DST') ? 'DEF' : pos;
    slots[key] = (slots[key] || 0) + 1;
  });
  return slots;
}

function slotEligible(pos, slotType) {
  if (slotType === 'FLEX') return ['RB', 'WR', 'TE'].includes(pos);
  if (slotType === 'SUPER_FLEX') return ['QB', 'RB', 'WR', 'TE'].includes(pos);
  if (slotType === 'REC_FLEX' || slotType === 'WRRB_FLEX') return ['RB', 'WR'].includes(pos);
  if (slotType === 'DEF') return pos === 'DEF' || pos === 'DST';
  return pos === slotType;
}

function computeOptimalLineup(matchup, playerPosMap, startingSlots) {
  const players = (matchup.players || []).map(pid => ({
    id: pid,
    pos: playerPosMap[pid] || 'UNK',
    points: Number(matchup.players_points?.[pid] || 0),
  }));
  players.sort((a, b) => b.points - a.points);

  const usedIds = new Set();
  const lineup = [];
  const order = ['QB', 'K', 'DEF', 'RB', 'WR', 'TE', 'REC_FLEX', 'WRRB_FLEX', 'FLEX', 'SUPER_FLEX'];
  for (const slotType of order) {
    const count = startingSlots[slotType] || 0;
    for (let i = 0; i < count; i++) {
      const player = players.find(p => !usedIds.has(p.id) && slotEligible(p.pos, slotType));
      if (player) {
        lineup.push({ ...player, slot: slotType });
        usedIds.add(player.id);
      }
    }
  }
  return { lineup, total: lineup.reduce((s, p) => s + p.points, 0) };
}

function findBiggestMissedSwap(matchup, playerPosMap) {
  const starters = matchup.starters || [];
  const players = matchup.players || [];
  const points = matchup.players_points || {};
  const bench = players.filter(id => !starters.includes(id));

  let biggest = null;
  for (const starterId of starters) {
    const starterPos = playerPosMap[starterId];
    const starterPts = Number(points[starterId] || 0);
    for (const benchId of bench) {
      const benchPos = playerPosMap[benchId];
      const benchPts = Number(points[benchId] || 0);
      if (starterPos !== benchPos) continue;   // exact position match
      const gain = benchPts - starterPts;
      if (!biggest || gain > biggest.gain) {
        biggest = {
          gain,
          benched_id: benchId, benched_pos: benchPos, benched_pts: benchPts,
          starter_id: starterId, starter_pos: starterPos, starter_pts: starterPts,
        };
      }
    }
  }
  return biggest && biggest.gain > 0 ? biggest : null;
}

function analyzeWeek(matchups, playerPosMap, startingSlots) {
  const pairs = new Map();
  (matchups || []).forEach(m => {
    if (m.matchup_id == null) return;
    if (!pairs.has(m.matchup_id)) pairs.set(m.matchup_id, []);
    pairs.get(m.matchup_id).push(m);
  });

  const teamResults = [];
  const donkeyCandidates = [];
  const coachCandidates = [];

  for (const pair of pairs.values()) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const ptsA = Number(a.points || 0);
    const ptsB = Number(b.points || 0);
    teamResults.push({ roster_id: a.roster_id, points: ptsA });
    teamResults.push({ roster_id: b.roster_id, points: ptsB });

    const optA = computeOptimalLineup(a, playerPosMap, startingSlots);
    const optB = computeOptimalLineup(b, playerPosMap, startingSlots);
    const missedA = Math.max(0, optA.total - ptsA);
    const missedB = Math.max(0, optB.total - ptsB);
    const marginA = ptsB - ptsA;
    const marginB = -marginA;

    if (ptsA < ptsB && missedA >= marginA && ptsB > 0) {
      donkeyCandidates.push({
        roster_id: a.roster_id, actual: ptsA, optimal: optA.total,
        missed: missedA, margin: marginA, opp_score: ptsB,
        swap: findBiggestMissedSwap(a, playerPosMap),
      });
    }
    if (ptsB < ptsA && missedB >= marginB && ptsA > 0) {
      donkeyCandidates.push({
        roster_id: b.roster_id, actual: ptsB, optimal: optB.total,
        missed: missedB, margin: marginB, opp_score: ptsA,
        swap: findBiggestMissedSwap(b, playerPosMap),
      });
    }

    if (ptsA > ptsB && ptsA > 0) {
      coachCandidates.push({
        roster_id: a.roster_id, actual: ptsA, optimal: optA.total,
        efficiency: optA.total > 0 ? ptsA / optA.total : 0,
        margin: ptsA - ptsB,
      });
    }
    if (ptsB > ptsA && ptsB > 0) {
      coachCandidates.push({
        roster_id: b.roster_id, actual: ptsB, optimal: optB.total,
        efficiency: optB.total > 0 ? ptsB / optB.total : 0,
        margin: ptsB - ptsA,
      });
    }
  }

  if (!teamResults.length) return null;
  teamResults.sort((a, b) => a.points - b.points);
  const lowest = teamResults[0];

  donkeyCandidates.sort((a, b) => b.missed - a.missed);
  const donkey = donkeyCandidates[0] || null;

  coachCandidates.sort((a, b) => b.efficiency - a.efficiency);
  const coach = coachCandidates[0] || null;

  return { donkey, coach, lowest };
}

// ------- Discord message builders -------

function hisGraceMessage(coach, teamName, managerName, week) {
  const romanWeek = toRoman(week);
  return {
    embeds: [{
      title: `👑  HIS GRACE OF WEEK ${romanWeek}`,
      description:
        `**${teamName}**\n` +
        `*Managed by ${managerName}*\n\n` +
        `For statistical excellence and sound roster construction, ` +
        `the Council doth hereby confer upon this manager the title of **His Grace** — ` +
        `a fleeting glory of no monetary consequence.\n\n` +
        `**Scored** ${coach.actual.toFixed(1)}  ·  ` +
        `**Efficiency** ${(coach.efficiency * 100).toFixed(0)}%  ·  ` +
        `**Margin** +${coach.margin.toFixed(1)}\n\n` +
        `_Sealed and stamped by the Council · Week ${romanWeek}_`,
      color: COLORS.gold,
    }],
  };
}

function theDonkeyMessage(donkey, teamName, managerName, playerName, week) {
  const romanWeek = toRoman(week);
  const swap = donkey.swap;

  let body;
  if (swap) {
    body =
      `**~~${teamName}~~**\n` +
      `*Managed by ${managerName}*\n\n` +
      `**HEAR YE · HEAR YE**\n\n` +
      `Let it be known throughout the land that this manager didst leave ` +
      `_${playerName[swap.benched_id] || 'a bench player'}_ and his ` +
      `**${swap.benched_pts.toFixed(1)} points** upon the bench, ` +
      `whilst starting the aptly-named _${playerName[swap.starter_id] || 'a starter'}_ ` +
      `for a meager ${swap.starter_pts.toFixed(1)}.\n\n` +
      `A defeat of ${donkey.margin.toFixed(1)} points — a mistake worth ` +
      `**${swap.gain.toFixed(1)}**.\n\n` +
      `**Verily, thou art a dumbass.**\n\n` +
      `_Recorded in the ledger of shame · Week ${romanWeek}_`;
  } else {
    body =
      `**~~${teamName}~~**\n` +
      `*Managed by ${managerName}*\n\n` +
      `**HEAR YE · HEAR YE**\n\n` +
      `This manager didst lose by ${donkey.margin.toFixed(1)} points whilst leaving ` +
      `**${donkey.missed.toFixed(1)}** points upon the bench — a defeat brought about ` +
      `entirely by his own hand.\n\n` +
      `**Verily, thou art a dumbass.**\n\n` +
      `_Recorded in the ledger of shame · Week ${romanWeek}_`;
  }

  return {
    embeds: [{
      title: `🐴  THE DONKEY OF WEEK ${romanWeek}`,
      description: body,
      color: COLORS.red,
    }],
  };
}

function thePeasantMessage(lowest, teamName, managerName, week) {
  const romanWeek = toRoman(week);
  return {
    embeds: [{
      title: `🤡  THE PEASANT OF WEEK ${romanWeek}`,
      description:
        `**~~${teamName}~~**\n` +
        `*Managed by ${managerName}*\n\n` +
        `**AND FURTHERMORE**\n\n` +
        `For scoring the meagerest sum of points in all the land — ` +
        `a paltry **${lowest.points.toFixed(1)}** — this manager is henceforth branded ` +
        `**The Peasant**, to till the fields of shame until such time as ` +
        `another produces a lower total.\n\n` +
        `He shall pay **$10** to the treasury for his troubles.\n\n` +
        `_Recorded in the ledger of shame · Week ${romanWeek}_`,
      color: COLORS.red,
    }],
  };
}

// ------- Main -------

async function main() {
  const state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
  const recapWeek = state.week - 1;
  if (recapWeek < 1 || recapWeek > 17) {
    console.log(`No week to judge (state.week=${state.week}).`);
    return;
  }

  // Dedup check
  const savedState = loadState();
  if (savedState.shame_last_week === recapWeek) {
    console.log(`Already posted Week ${recapWeek} ceremonies. Skipping.`);
    return;
  }

  console.log(`The Council convenes to judge Week ${recapWeek}…`);

  // Fetch everything in parallel
  const [rosters, users, matchups, league, sleeperPlayersRaw] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${recapWeek}`),
    fetchJson(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`),
    fetchJson('https://api.sleeper.app/v1/players/nfl'),
  ]);

  if (!matchups?.length) {
    console.log('No matchups for that week.');
    return;
  }
  const hasScoring = matchups.some(m => (m.points || 0) > 0);
  if (!hasScoring) {
    console.log('No scoring recorded yet for that week.');
    return;
  }

  // Build lookup maps
  const userById = new Map(users.map(u => [u.user_id, u]));
  const teams = new Map();
  rosters.forEach(r => {
    const u = userById.get(r.owner_id) || {};
    const teamName = (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`;
    const managerName = u.display_name || u.username || 'a manager';
    teams.set(r.roster_id, { team_name: teamName, manager_name: managerName });
  });

  const playerPos = {};
  const playerName = {};
  for (const [id, p] of Object.entries(sleeperPlayersRaw || {})) {
    if (!p) continue;
    playerPos[id] = p.position;
    playerName[id] = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'a player';
  }

  const startingSlots = extractStartingSlots(league?.roster_positions);
  console.log('Starting slots:', startingSlots);

  const analysis = analyzeWeek(matchups, playerPos, startingSlots);
  if (!analysis) {
    console.log('Analysis returned nothing.');
    return;
  }

  const { donkey, coach, lowest } = analysis;

  // Get team info for each award
  const coachInfo  = coach  ? teams.get(coach.roster_id)  : null;
  const donkeyInfo = donkey ? teams.get(donkey.roster_id) : null;
  const lowestInfo = lowest ? teams.get(lowest.roster_id) : null;

  console.log('His Grace:', coachInfo?.team_name || 'none');
  console.log('The Donkey:', donkeyInfo?.team_name || 'none qualified');
  console.log('The Peasant:', lowestInfo?.team_name || 'none');

  // Post His Grace first (if a coach was crowned)
  if (coach && coachInfo) {
    console.log('Posting His Grace…');
    await postToDiscord(WEBHOOK, hisGraceMessage(coach, coachInfo.team_name, coachInfo.manager_name, recapWeek));
    await sleep(MESSAGE_DELAY_MS);
  }

  // Post The Donkey (if anyone qualified)
  if (donkey && donkeyInfo) {
    console.log('Posting The Donkey…');
    await postToDiscord(WEBHOOK, theDonkeyMessage(donkey, donkeyInfo.team_name, donkeyInfo.manager_name, playerName, recapWeek));
    await sleep(MESSAGE_DELAY_MS);
  }

  // Post The Peasant
  if (lowest && lowestInfo) {
    console.log('Posting The Peasant…');
    await postToDiscord(WEBHOOK, thePeasantMessage(lowest, lowestInfo.team_name, lowestInfo.manager_name, recapWeek));
  }

  // Save state so we don't repost if the workflow runs again
  savedState.shame_last_week = recapWeek;
  saveState(savedState);

  console.log('The Council rests.');
}

main().catch(e => {
  console.error('Studs & Duds post failed:', e);
  process.exit(1);
});
