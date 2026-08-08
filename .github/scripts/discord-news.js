/**
 * Posts new news items (wire + FantasyPros) to Discord.
 * Deduplicates via posted_news_ids tracked in discord-state.json.
 */
const fs = require('fs');
const { postToDiscord, sleep, loadState, saveState, COLORS } = require('./discord-lib');

const WEBHOOK = process.env.DISCORD_NEWS_WEBHOOK;
const MAX_ITEMS_PER_RUN = 10;   // Cap posts per run to avoid flooding on first run
const RETAIN_IDS = 500;         // Keep last N posted IDs to prevent re-posts

if (!WEBHOOK) {
  console.log('DISCORD_NEWS_WEBHOOK not set — skipping.');
  process.exit(0);
}

function readJsonSafe(path) {
  try {
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    console.log(`Couldn't read ${path}: ${e.message}`);
    return null;
  }
}

function collectItems() {
  const items = [];

  // Wire.json format: { items: [{ title, link, source, pubDate, description }] }
  const wire = readJsonSafe('assets/data/wire.json');
  if (wire && Array.isArray(wire.items)) {
    wire.items.forEach(it => {
      items.push({
        id: `wire:${it.link || it.title}`,
        source: (it.source || 'Wire').toUpperCase(),
        title: it.title || '(untitled)',
        link: it.link || null,
        description: (it.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 300),
        pubDate: it.pubDate || it.date || null,
      });
    });
  }

  // FantasyPros.json format: { items: [{ id, title, link, desc, impact, created }] }
  const fp = readJsonSafe('assets/data/fantasypros.json');
  if (fp && Array.isArray(fp.items)) {
    fp.items.forEach(it => {
      const desc = (it.impact || it.desc || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
      items.push({
        id: `fp:${it.id || it.link}`,
        source: 'FANTASYPROS',
        title: it.title || '(untitled)',
        link: it.link || null,
        description: desc,
        pubDate: it.created || null,
      });
    });
  }

  return items;
}

function itemToEmbed(item) {
  return {
    author: { name: item.source },
    title: item.title.slice(0, 250),
    url: item.link || undefined,
    description: item.description || undefined,
    color: COLORS.gold,
    timestamp: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
    footer: { text: '12guys1cup • Wire' },
  };
}

async function main() {
  const state = loadState();
  const postedIds = new Set(state.posted_news_ids || []);

  const allItems = collectItems();
  console.log(`Collected ${allItems.length} items across sources.`);

  // Only NEW items (not already posted)
  const newItems = allItems.filter(it => !postedIds.has(it.id));
  console.log(`${newItems.length} are new (not previously posted).`);

  if (!newItems.length) {
    console.log('Nothing to post.');
    return;
  }

  // On the very first run, don't flood — post most recent MAX_ITEMS_PER_RUN only.
  // Sort newest first (best-effort by pubDate; items without dates fall to end)
  newItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  const toPost = newItems.slice(0, MAX_ITEMS_PER_RUN);
  console.log(`Posting ${toPost.length} to Discord...`);

  let posted = 0;
  for (const it of toPost) {
    try {
      await postToDiscord(WEBHOOK, { embeds: [itemToEmbed(it)] });
      postedIds.add(it.id);
      posted++;
      await sleep(300);  // Rate-limit safety (30 req/min = 2s per; 300ms is well under)
    } catch (e) {
      console.log(`Post failed for "${it.title}": ${e.message}`);
    }
  }

  // If more items were skipped, still mark them as "seen" so we don't post them later
  // (they'd be days old by the next run)
  newItems.slice(MAX_ITEMS_PER_RUN).forEach(it => postedIds.add(it.id));

  // Trim the tracking set to the most recent RETAIN_IDS
  const idsArr = Array.from(postedIds);
  const trimmed = idsArr.slice(-RETAIN_IDS);

  state.posted_news_ids = trimmed;
  state.last_check = new Date().toISOString();
  saveState(state);

  console.log(`Posted ${posted}. Tracked IDs: ${trimmed.length}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
