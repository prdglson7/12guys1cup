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
console.log(`Loaded ${FEEDS.length} feed(s) from config.js`);

// -- Fetcher ----------------------------------------------------------------
const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; 12guys1cup-wire/1.0; +https://12guys1cup.com)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});

async function fetchRss(feed) {
  const label = `[${feed.tag.padEnd(12)}]`;
  try {
    const data = await parser.parseURL(feed.url);
    const items = (data.items || []).slice(0, 15).map(it => {
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
    console.log(`${label} ✓ ${items.length} items`);
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

async function main() {
  const started = Date.now();
  const results = await Promise.all(FEEDS.map(fetchOne));

  const items = results
    .flatMap(r => r.items)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const okSources = results.filter(r => r.ok).length;
  const summary = results.map(r => `${r.tag}:${r.ok ? r.items.length : 'X'}`).join(' ');

  const out = {
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    total_sources: results.length,
    ok_sources: okSources,
    total_items: items.length,
    summary,
    items: items.slice(0, 100),  // cap for reasonable file size
  };

  const outPath = 'assets/data/wire.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`Wrote ${outPath}`);
  console.log(`  ${out.total_items} items merged, kept top ${out.items.length}`);
  console.log(`  ${okSources}/${results.length} sources OK`);
  console.log(`  ${summary}`);
  console.log(`  ${out.duration_ms}ms`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
