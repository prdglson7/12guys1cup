/**
 * Posts new + status-changed injuries to Discord.
 * Tracks status by player_id in discord-state.json.
 */
const fs = require('fs');
const { postToDiscord, sleep, loadState, saveState, COLORS } = require('./discord-lib');

const WEBHOOK = process.env.DISCORD_INJURIES_WEBHOOK;
const MAX_ITEMS_PER_RUN = 15;

// Only these statuses are noteworthy — skip pings for "Probable" or "NA" (routine)
const NOTEWORTHY_STATUSES = new Set(['Out', 'IR', 'PUP', 'Doubtful', 'Questionable', 'Sus']);

if (!WEBHOOK) {
  console.log('DISCORD_INJURIES_WEBHOOK not set — skipping.');
  process.exit(0);
}

function statusColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'out' || s === 'ir') return 0xC43D2E;    // deep red
  if (s === 'doubtful' || s === 'pup') return 0xE65100; // orange
  if (s === 'questionable') return 0xE8B84A;         // gold
  return COLORS.navy;
}

function injuryToEmbed(inj, oldStatus) {
  const changeText = oldStatus
    ? `Status changed: **${oldStatus}** → **${inj.status}**`
    : `New injury: **${inj.status}**`;

  const parts = [changeText];
  if (inj.injury_type) parts.push(`Injury: ${inj.injury_type}`);
  if (inj.comment) parts.push(inj.comment.replace(/<[^>]+>/g, '').trim().slice(0, 400));

  return {
    author: { name: `${inj.name} — ${inj.team_id || 'FA'} ${inj.position_id || ''}`.trim() },
    description: parts.join('\n'),
    color: statusColor(inj.status),
    footer: { text: '12guys1cup • Injuries' },
    timestamp: inj.injury_update_date ? new Date(inj.injury_update_date).toISOString() : undefined,
  };
}

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync('assets/data/fantasypros-injuries.json', 'utf8'));
  } catch (e) {
    console.log(`No injuries data yet: ${e.message}`);
    return;
  }
  const list = data.injuries || [];
  console.log(`Loaded ${list.length} injury records.`);

  const state = loadState();
  const prev = state.injuries_by_player || {};

  // Build list of noteworthy changes
  const changes = [];
  for (const inj of list) {
    if (!inj.player_id || !inj.status) continue;
    if (!NOTEWORTHY_STATUSES.has(inj.status)) continue;
    const oldStatus = prev[inj.player_id];
    if (oldStatus !== inj.status) {
      changes.push({ inj, oldStatus });
    }
  }
  console.log(`${changes.length} noteworthy changes to post.`);

  // First-run guard: if state was empty, don't blast 100+ injuries.
  // Still update state so future runs only see real changes.
  const isFirstRun = Object.keys(prev).length === 0;
  if (isFirstRun) {
    console.log('First run — seeding state without posting.');
    const seeded = {};
    for (const inj of list) {
      if (inj.player_id && inj.status) seeded[inj.player_id] = inj.status;
    }
    state.injuries_by_player = seeded;
    state.last_check = new Date().toISOString();
    saveState(state);
    console.log(`Seeded ${Object.keys(seeded).length} player statuses.`);
    return;
  }

  const toPost = changes.slice(0, MAX_ITEMS_PER_RUN);
  let posted = 0;
  for (const { inj, oldStatus } of toPost) {
    try {
      await postToDiscord(WEBHOOK, { embeds: [injuryToEmbed(inj, oldStatus)] });
      posted++;
      await sleep(300);
    } catch (e) {
      console.log(`Failed for ${inj.name}: ${e.message}`);
    }
  }

  // Update state for ALL current statuses (even ones we didn't post — over cap)
  const updated = { ...prev };
  for (const inj of list) {
    if (inj.player_id && inj.status) updated[inj.player_id] = inj.status;
  }
  state.injuries_by_player = updated;
  state.last_check = new Date().toISOString();
  saveState(state);

  console.log(`Posted ${posted}. Tracking ${Object.keys(updated).length} players.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
