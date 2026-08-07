/**
 * Fetches all RSS feeds from RSS_FEEDS in assets/js/config.js,
 * merges + sorts them, and writes to assets/data/wire.json.
 *
 * Run by .github/workflows/update-wire.yml every 15 minutes.
 * Single source of truth: config.js. Add/remove sources there,
 * both client and this script pick it up automatically.
 */
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

// -- Parse the RSS feed list out of the client config -----------------------
const configText = fs.readFileSync('assets/js/config.js', 'utf8');
const match = configText.match(/window\.Config\s*=\s*(\{[\s\S]*?\});/);
if (!match) {
  console.error('Could not extract window.Config = { ... } from config.js');
  process.exit(1);
}
const CONFIG = eval('(' + match[1] + ')');
const FEEDS = CONFIG.RSS_FEEDS || [];
const INSIDER_KEYWORDS = (CONFIG.INSIDER_KEYWORDS || []).map(k => k.toLowerCase());
console.log(`Loaded ${FEEDS.length} feed(s) from config.js`);
console.log(`Insider keyword filter: ${INSIDER_KEYWORDS.length} terms`);

/* When feed.filterInsiders is true, keep only items whose title/description
   contain one of the INSIDER_KEYWORDS. Used for Reddit noise reduction. */
function passesInsiderFilter(item) {
  if (!INSIDER_KEYWORDS.length) return true;
  const hay = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
  return INSIDER_KEYWORDS.some(k => hay.includes(k));
}

// -- Fetcher ----------------------------------------------------------------
const parser = new Parser({
  timeout: 8000,  // 8s per feed — fail fast on stragglers, keep others rolling
  headers: {
    // Reddit rejects generic bots — use a browser-style UA that all our sources accept
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 12guys1cup-wire/1.0',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

async function fetchRss(feed) {
  const label = `[${feed.tag.padEnd(12)}]`;
  try {
    const data = await parser.parseURL(feed.url);
    const rawItems = (data.items || []).slice(0, 25).map(it => {
      const isoTs = it.isoDate ? new Date(it.isoDate).getTime() : 0;
      const pubTs = it.pubDate ? new Date(it.pubDate).getTime() : 0;
      const ts = isoTs || pubTs || 0;
      return {
        title: (it.title || '').trim(),
        link: it.link || it.guid || '',
        description: (it.contentSnippet || it.content || it.summary || '')
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 240),
        pubDate: it.isoDate || it.pubDate || '',
        ts,
        source: feed.tag,
      };
    }).filter(x => x.title && x.link);
    const items = feed.filterInsiders
      ? rawItems.filter(passesInsiderFilter)
      : rawItems;
    const filtered = feed.filterInsiders ? ` (${rawItems.length} → ${items.length} after filter)` : '';
    console.log(`${label} ✓ ${items.length} items${filtered}`);
    return { ok: true, tag: feed.tag, items };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, tag: feed.tag, items: [], error: e.message };
  }
}

async function fetchEspnJson(feed) {
  const label = `[${feed.tag.padEnd(12)}]`;
  try {
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      https.get(feed.url, { timeout: 15000 }, res => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });
    const json = JSON.parse(raw);
    const items = (json.articles || []).slice(0, 15).map(a => {
      const link = (a.links && a.links.web && a.links.web.href) || '';
      const ts = a.published ? new Date(a.published).getTime() : 0;
      return {
        title: (a.headline || '').trim(),
        link,
        description: (a.description || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240),
        pubDate: a.published || '',
        ts,
        source: feed.tag,
      };
    }).filter(x => x.title && x.link);
    console.log(`${label} ✓ ${items.length} items (JSON)`);
    return { ok: true, tag: feed.tag, items };
  } catch (e) {
    console.log(`${label} ✗ ${e.message}`);
    return { ok: false, tag: feed.tag, items: [], error: e.message };
  }
}

async function fetchOne(feed) {
  if (feed.type === 'espn-json') return fetchEspnJson(feed);
  return fetchRss(feed);
}

/* Global safety filter: drop items about non-NFL sports.
   This applies to ALL feeds — even if RotoBaller (or any source) posts a
   stray NBA/MLB/UFC item it never makes it to your Wire. */
const NON_NFL_KEYWORDS = /\b(nba|mlb|mls|nhl|mma|ufc|pga|lpga|nascar|f1|formula ?1|wnba|soccer|epl|premier league|la liga|serie a|bundesliga|champions league|cricket|tennis|atp|wta|indycar|boxing|wwe|hockey|baseball|basketball)\b/i;

function isNflOnly(item) {
  const hay = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
  return !NON_NFL_KEYWORDS.test(hay);
}

async function main() {
  const started = Date.now();
  const results = await Promise.all(FEEDS.map(fetchOne));

  const allItems = results.flatMap(r => r.items);

  // Filter to NFL-only (drops NBA, MLB, UFC, etc.)
  const nflItems = allItems.filter(isNflOnly);
  const nonNflDropped = allItems.length - nflItems.length;

  // Dedupe by canonical URL — same story fetched from multiple category
  // feeds is common with RotoBaller. Keep the first occurrence.
  const seen = new Set();
  const items = [];
  for (const item of nflItems) {
    const key = (item.link || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    if (key && seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  const dupCount = nflItems.length - items.length;

  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const okSources = results.filter(r => r.ok).length;
  const summary = results.map(r => `${r.tag}:${r.ok ? r.items.length : 'X'}`).join(' ');

  const out = {
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    total_sources: results.length,
    ok_sources: okSources,
    total_items: items.length,
    non_nfl_dropped: nonNflDropped,
    duplicates_removed: dupCount,
    summary,
    items: items.slice(0, 100),
  };

  const outPath = 'assets/data/wire.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`Wrote ${outPath}`);
  console.log(`  ${allItems.length} raw → ${nflItems.length} after NFL filter (${nonNflDropped} non-NFL dropped)`);
  console.log(`  ${nflItems.length} → ${items.length} after dedup (${dupCount} duplicates)`);
  console.log(`  Kept top ${out.items.length}`);
  console.log(`  ${okSources}/${results.length} sources OK`);
  console.log(`  ${summary}`);
  console.log(`  ${out.duration_ms}ms`);
}

main()
  .then(() => process.exit(0))   // rss-parser holds open sockets; force exit
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
