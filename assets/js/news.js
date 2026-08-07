/* =========================================================
   News layer
   ESPN's public NFL news endpoint returns JSON with CORS.
   Fallback: no key needed, no proxy needed.
   ========================================================= */

const ESPN_NEWS = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=40";

async function getEspnNews() {
  const res = await fetch(ESPN_NEWS);
  if (!res.ok) throw new Error(`ESPN news → ${res.status}`);
  const data = await res.json();
  return (data.articles || []).map(a => ({
    id: a.id,
    headline: a.headline,
    description: a.description || "",
    published: a.published,
    link: (a.links && a.links.web && a.links.web.href) || "#",
    byline: a.byline || "ESPN",
    categories: (a.categories || []).map(c => c.description || c.type || ""),
    athleteIds: (a.categories || [])
      .filter(c => c.type === "athlete")
      .map(c => (c.athlete && c.athlete.id) || c.athleteId)
      .filter(Boolean),
    athleteNames: (a.categories || [])
      .filter(c => c.type === "athlete")
      .map(c => c.description)
      .filter(Boolean),
  }));
}

/* Build set of rostered player names across the league */
function rosteredPlayerNames(rosters, players) {
  const names = new Set();
  rosters.forEach(r => {
    (r.players || []).forEach(pid => {
      const p = players[pid];
      if (p && p.full_name) names.add(p.full_name.toLowerCase());
      if (p && p.first_name && p.last_name)
        names.add(`${p.first_name} ${p.last_name}`.toLowerCase());
    });
  });
  return names;
}

/* Does the article mention any rostered player? */
function articleTouchesRoster(article, rosterNamesSet) {
  const hay = `${article.headline} ${article.description}`.toLowerCase();
  for (const name of rosterNamesSet) {
    if (name.length > 6 && hay.includes(name)) return true;
  }
  for (const aname of article.athleteNames) {
    if (rosterNamesSet.has((aname || "").toLowerCase())) return true;
  }
  return false;
}

/* ---- Sleeper trending adds (free, CORS-safe) ---- */
async function getSleeperTrending(type = "add", hours = 24, limit = 25) {
  const url = `https://api.sleeper.app/v1/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper trending → ${res.status}`);
  return res.json();   // [{ player_id, count }]
}

/* ---- RSS via CORS proxy ---- */
async function fetchRssFeed(url, tag) {
  const proxy = (window.Config && window.Config.CORS_PROXY) || "https://api.allorigins.win/get?url=";
  const res = await fetch(proxy + encodeURIComponent(url));
  if (!res.ok) throw new Error(`RSS ${tag} → ${res.status}`);
  const data = await res.json();
  const raw = data.contents || "";
  const xml = new DOMParser().parseFromString(raw, "text/xml");
  if (xml.querySelector("parsererror")) throw new Error(`RSS ${tag} parse error`);

  return Array.from(xml.querySelectorAll("item")).slice(0, 20).map(item => {
    const get = sel => (item.querySelector(sel)?.textContent || "").trim();
    const pub = get("pubDate") || get("dc\\:date") || get("date");
    return {
      title: get("title"),
      link:  get("link"),
      description: get("description")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220),
      pubDate: pub,
      ts: pub ? new Date(pub).getTime() : 0,
      source: tag,
    };
  }).filter(x => x.title);
}

async function fetchAllRss() {
  const feeds = (window.Config && window.Config.RSS_FEEDS) || [];
  const results = await Promise.allSettled(
    feeds.map(f => fetchRssFeed(f.url, f.tag))
  );
  const items = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return items;
}

/* ---- Reddit: public .json endpoints, CORS-safe, no key ---- */
async function fetchSubreddit(sub, tag, limit = 25) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=${limit}&raw_json=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reddit r/${sub} → ${res.status}`);
  const data = await res.json();
  const posts = (data.data && data.data.children) || [];
  return posts.map(p => {
    const d = p.data || {};
    return {
      title: (d.title || "").replace(/\s+/g, " ").trim(),
      link: d.permalink ? `https://www.reddit.com${d.permalink}` : (d.url || "#"),
      description: (d.selftext || "").replace(/\s+/g, " ").trim().slice(0, 240),
      pubDate: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "",
      ts: d.created_utc ? d.created_utc * 1000 : 0,
      source: tag,
      author: d.author ? `u/${d.author}` : "",
      score: d.score || 0,
    };
  }).filter(x => x.title);
}

function matchesInsiderKeyword(title, keywords) {
  if (!keywords || !keywords.length) return true;
  const t = (title || "").toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

async function fetchAllReddit() {
  const cfg = window.Config || {};
  const subs = cfg.REDDIT_SUBS || [];
  const keywords = cfg.INSIDER_KEYWORDS || [];
  const results = await Promise.allSettled(
    subs.map(s => fetchSubreddit(s.sub, s.tag, s.limit || 25))
  );
  let items = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const src = subs[i];
    const filtered = src.filterInsiders
      ? r.value.filter(x => matchesInsiderKeyword(x.title, keywords))
      : r.value;
    items = items.concat(filtered);
  });
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return items;
}

/* ---- Static wire (pre-fetched by GitHub Action every 15 min) ----
   Client reads assets/data/wire.json instead of hitting the CORS proxy.
   Also cached in localStorage for 5 min so repeat visits are instant. */
const WIRE_CACHE_KEY = "wire.static.v1";
const WIRE_CACHE_TTL = 5 * 60 * 1000;  // 5 minutes

async function getWireStatic() {
  // localStorage cache first
  try {
    const raw = localStorage.getItem(WIRE_CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < WIRE_CACHE_TTL) {
        return { items: data.items || [], cached: true, fetched_at: data.fetched_at };
      }
    }
  } catch (_) { /* fall through */ }

  const res = await fetch("assets/data/wire.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`wire.json → ${res.status}`);
  const data = await res.json();

  try {
    localStorage.setItem(WIRE_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {}

  return { items: data.items || [], cached: false, fetched_at: data.fetched_at };
}

/* ---- FantasyPros: reads static JSON produced by GitHub Actions ----
   Same localStorage pattern as wire — 10min TTL since FP refreshes every 2h.
   The workflow at .github/workflows/update-fantasypros.yml refreshes
   assets/data/fantasypros.json. Key never touches the client. */
const FP_CACHE_KEY = "fp.news.v1";
const FP_CACHE_TTL = 10 * 60 * 1000;

async function getFantasyProsNews() {
  try {
    const raw = localStorage.getItem(FP_CACHE_KEY);
    if (raw) {
      const { ts, items } = JSON.parse(raw);
      if (Date.now() - ts < FP_CACHE_TTL) return items;
    }
  } catch (_) {}

  const res = await fetch("assets/data/fantasypros.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`FantasyPros feed → ${res.status}`);
  const data = await res.json();
  const items = (data.items || []).map(it => ({
    id: it.id,
    title: it.title || "",
    link: it.link || "#",
    description: (it.desc || it.body || it.description || "").replace(/<[^>]*>/g, "").trim().slice(0, 240),
    impact: (it.impact || "").replace(/<[^>]*>/g, "").trim().slice(0, 240),
    pubDate: it.created || it.created_formated || "",
    ts: it.created ? new Date(it.created.replace(" ", "T") + "Z").getTime() : 0,
    source: "FANTASYPROS",
    player_id: it.player_id || null,
    team: it.team_id || "",
    author: it.author || "",
    categories: it.categories || [],
  })).filter(x => x.title);

  try {
    localStorage.setItem(FP_CACHE_KEY, JSON.stringify({ ts: Date.now(), items }));
  } catch (_) {}

  return items;
}

/* FantasyPros official injury report (practice reports, prob of playing, etc.) */
async function getFantasyProsInjuries() {
  const res = await fetch("assets/data/fantasypros-injuries.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`FantasyPros injuries → ${res.status}`);
  const data = await res.json();
  const list = data.injuries || [];
  return list.map(inj => ({
    player_id: inj.player_id,
    name: inj.name || "",
    team: inj.team_id || "",
    position: inj.position_id || "",
    status: inj.status || "",
    status_short: inj.status_short || "",
    injury_type: inj.injury_type || "",
    comment: inj.comment || "",
    update_date: inj.injury_update_date || "",
    probability: inj.probability_of_playing != null ? Number(inj.probability_of_playing) : null,
    practice_1: inj.practice_1 || "",
    practice_2: inj.practice_2 || "",
    practice_3: inj.practice_3 || "",
    practice_report_injury_type: inj.practice_report_injury_type || "",
  }));
}

/* ---- Draft Kit: reads static JSON from GitHub Actions ---- */
const DK_CACHE_KEY = "dk.static.v1";
const DK_CACHE_TTL = 30 * 60 * 1000;  // 30 min

async function getDraftKit() {
  try {
    const raw = localStorage.getItem(DK_CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < DK_CACHE_TTL) return data;
    }
  } catch (_) {}

  const res = await fetch("assets/data/draftkit.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`draftkit.json → ${res.status}`);
  const data = await res.json();
  try {
    localStorage.setItem(DK_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {}
  return data;
}

/* ---- Draft Sharks CSV overlay (manually updated by user) ----
   Two files expected:
     assets/data/draft-sharks/rankings.csv  - Draft War Room "Rankings PPR" export
     assets/data/draft-sharks/adps.csv      - Draft War Room ADPs export
   Both are optional — page falls back gracefully if either is missing. */

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const cells = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        cells.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    return cells.map(s => s.trim());
  };

  const headers = parseLine(lines[0]).map(h => h.toLowerCase().trim());
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const cells = parseLine(line);
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i] || '');
    return row;
  });
  return { headers, rows };
}

const _num = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[%,]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};

/* Rankings CSV — has: Rank, Team, Player, Fantasy Position, Games, ADP, Bye,
   SOS, InjuryRisk, Floor Proj, Consensus Proj, DS Proj, CeilingProj, 3D Value */
async function getDraftSharksRankings() {
  try {
    const res = await fetch("assets/data/draft-sharks/rankings.csv", { cache: "no-cache" });
    if (!res.ok) return { rows: [], hasData: false };
    const text = await res.text();
    const { rows } = parseCsv(text);
    if (!rows.length) return { rows: [], hasData: false };

    const normalized = rows.map(r => ({
      rank: parseInt(r.rank, 10) || null,
      name: r.player || r.name || '',
      pos: (r['fantasy position'] || r.position || '').toUpperCase(),
      team: (r.team || '').toUpperCase(),
      bye: r.bye || '',
      adp: _num(r.adp),
      games: _num(r.games),
      sos: r.sos || '',
      injury_risk: r.injuryrisk || r['injury risk'] || '',
      floor: _num(r['floor proj']),
      proj: _num(r['consensus proj']),
      ds_proj: _num(r['ds proj']),
      ceiling: _num(r.ceilingproj || r['ceiling proj']),
      value_3d: _num(r['3d value']),
    })).filter(r => r.name);

    return { rows: normalized, hasData: true, count: normalized.length };
  } catch (e) {
    return { rows: [], hasData: false, error: e.message };
  }
}

/* ADP CSV — has: Player Name, Player Team, Player Position, DS Rank,
   CBS Redraft 1 PPR ADP, Consensus Redraft 1 PPR ADP, Sleeper Redraft 1 PPR ADP,
   plus Market Index deltas for each platform. */
async function getDraftSharksAdps() {
  try {
    const res = await fetch("assets/data/draft-sharks/adps.csv", { cache: "no-cache" });
    if (!res.ok) return { rows: [], hasData: false };
    const text = await res.text();
    const { rows } = parseCsv(text);
    if (!rows.length) return { rows: [], hasData: false };

    // Column name matching is lenient because the platform prefix can vary
    const findKey = (row, needle) => {
      const keys = Object.keys(row);
      return keys.find(k => k.includes(needle));
    };
    const sample = rows[0];
    const cbsKey       = findKey(sample, 'cbs') && !findKey(sample, 'cbs')?.includes('market') ? findKey(sample, 'cbs') : null;
    const cbsAdpKey    = Object.keys(sample).find(k => k.includes('cbs') && k.includes('adp') && !k.includes('market'));
    const cbsMarketKey = Object.keys(sample).find(k => k.includes('cbs') && k.includes('market'));
    const consAdpKey    = Object.keys(sample).find(k => k.includes('consensus') && k.includes('adp') && !k.includes('market'));
    const consMarketKey = Object.keys(sample).find(k => k.includes('consensus') && k.includes('market'));
    const sleepAdpKey    = Object.keys(sample).find(k => k.includes('sleeper') && k.includes('adp') && !k.includes('market'));
    const sleepMarketKey = Object.keys(sample).find(k => k.includes('sleeper') && k.includes('market'));

    const normalized = rows.map(r => ({
      name: r['player name'] || r.name || '',
      team: (r['player team'] || r.team || '').toUpperCase(),
      pos: (r['player position'] || r.position || '').toUpperCase(),
      ds_rank: parseInt(r['ds rank'], 10) || null,
      cbs_adp:      cbsAdpKey    ? _num(r[cbsAdpKey])    : null,
      cbs_market:   cbsMarketKey ? _num(r[cbsMarketKey]) : null,
      cons_adp:     consAdpKey   ? _num(r[consAdpKey])   : null,
      cons_market:  consMarketKey? _num(r[consMarketKey]): null,
      sleep_adp:    sleepAdpKey  ? _num(r[sleepAdpKey])  : null,
      sleep_market: sleepMarketKey ? _num(r[sleepMarketKey]) : null,
    })).filter(r => r.name);

    return { rows: normalized, hasData: true, count: normalized.length };
  } catch (e) {
    return { rows: [], hasData: false, error: e.message };
  }
}

window.News = {
  getEspnNews, rosteredPlayerNames, articleTouchesRoster,
  getSleeperTrending, fetchRssFeed, fetchAllRss,
  fetchSubreddit, fetchAllReddit,
  getFantasyProsNews, getFantasyProsInjuries,
  getWireStatic, getDraftKit,
  getDraftSharksRankings, getDraftSharksAdps,
};
