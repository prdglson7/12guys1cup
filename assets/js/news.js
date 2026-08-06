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

window.News = {
  getEspnNews, rosteredPlayerNames, articleTouchesRoster,
  getSleeperTrending, fetchRssFeed, fetchAllRss,
};
