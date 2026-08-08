/* =========================================================
   Page renderers
   Each renderXxx() targets a container id and hits the API.
   ========================================================= */
(function() {

const { getState, getLeague, getUsers, getRosters, getMatchups,
        getTransactions, getWinnersBracket, getPlayers,
        buildTeamMap, computePowerRankings } = window.Sleeper;
const { getEspnNews, rosteredPlayerNames, articleTouchesRoster,
        getSleeperTrending, fetchAllRss, fetchAllReddit,
        getFantasyProsNews, getFantasyProsInjuries, getWireStatic,
        getDraftKit, getFpSleepers, getFpBusts, getFpHandcuffs } = window.News;
const { loading, empty, errBox, esc, fmt1, fmt2, relTime, avatarUrl } = window.UI;

/* ---------- Cached shared bootstrap ---------- */
let _bootstrapPromise = null;
async function bootstrap() {
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    const [state, league, users, rosters] = await Promise.all([
      getState(), getLeague(), getUsers(), getRosters(),
    ]);
    const teams = buildTeamMap(users, rosters);
    return { state, league, users, rosters, teams };
  })();
  return _bootstrapPromise;
}

/* Determine what week to show. During the season, use current week.
   Pre-season, fall back to week 1. */
function displayWeek(state, league) {
  const seasonType = state.season_type;      // 'pre' | 'regular' | 'post' | 'off'
  const week = state.week || 1;
  if (seasonType === 'regular' || seasonType === 'post') return week;
  return 1;
}

/* ---------- Matchup card ---------- */
function matchupCardHtml(a, b) {
  const winner =
    a && b && a.points !== undefined && b.points !== undefined
      ? (a.points > b.points ? "left" : b.points > a.points ? "right" : "")
      : "";
  const teamBlock = (t, side) => t ? `
    <div class="team ${side}">
      <img class="avatar" src="${esc(avatarUrl(t))}" alt="" onerror="this.src='assets/img/logo.jpg'">
      <div class="name">${esc(t.team_name)}</div>
    </div>` : `<div class="team ${side}"><div class="name">TBD</div></div>`;
  return `
    <div class="matchup ${winner ? 'winner-'+winner : ''}">
      ${teamBlock(a, 'left')}
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
        <div class="score">${fmt1(a ? a.points : 0)}</div>
        <div class="vs">VS</div>
        <div class="score">${fmt1(b ? b.points : 0)}</div>
      </div>
      ${teamBlock(b, 'right')}
    </div>`;
}

/* Group matchups by matchup_id */
function pairMatchups(matchups, teams) {
  const groups = new Map();
  matchups.forEach(m => {
    const key = m.matchup_id ?? `solo-${m.roster_id}`;
    if (!groups.has(key)) groups.set(key, []);
    const team = teams.get(m.roster_id);
    groups.get(key).push({ ...team, points: m.points || 0, roster_id: m.roster_id });
  });
  return Array.from(groups.values());
}

/* ---------- HOME ---------- */
async function renderHome() {
  const heroEl = document.getElementById("hero");
  const matchupsEl = document.getElementById("home-matchups");
  const standingsEl = document.getElementById("home-standings");
  const newsEl = document.getElementById("home-news");

  heroEl.innerHTML = loading("Loading league…");
  matchupsEl.innerHTML = loading();
  standingsEl.innerHTML = loading();
  newsEl.innerHTML = loading();

  try {
    const { state, league, teams } = await bootstrap();
    const week = displayWeek(state, league);
    const season = league.season;

    heroEl.innerHTML = `
      <div class="hero-strip">
        <div>
          <div class="kicker">${esc(league.name)} • ${esc(season)} season</div>
          <h1>Week ${week} on tap</h1>
        </div>
        <div class="weeknum">W${week}</div>
      </div>`;

    // Matchups — ESPN-style horizontal ticker (auto-scrolls, pauses on hover)
    try {
      const m = await getMatchups(week);
      if (!m.length) {
        matchupsEl.innerHTML = `
          <div class="ticker-shell">
            <div class="ticker-badge">WEEK ${week}</div>
            <div class="ticker-empty">Season starting soon — matchups populate as the league schedule is set.</div>
          </div>`;
      } else {
        const pairs = pairMatchups(m, teams);
        const now = Date.now();
        const stateLabel = (a, b) => {
          const scored = (Number(a?.points) || 0) + (Number(b?.points) || 0);
          if (scored > 0.1) return { label: "LIVE", cls: "live" };
          return { label: "PRE",  cls: "pre" };
        };
        const tickerItem = (a, b) => {
          const st = stateLabel(a, b);
          const aName = esc(a?.team?.name || "TBD");
          const bName = esc(b?.team?.name || "TBD");
          const aScore = (Number(a?.points) || 0).toFixed(1);
          const bScore = (Number(b?.points) || 0).toFixed(1);
          const aAvatar = a?.team?.avatar
            ? `<img class="ticker-avatar" src="${esc(avatarUrl(a.team.avatar))}" alt="">`
            : `<div class="ticker-avatar-blank">${esc(aName[0] || "?")}</div>`;
          const bAvatar = b?.team?.avatar
            ? `<img class="ticker-avatar" src="${esc(avatarUrl(b.team.avatar))}" alt="">`
            : `<div class="ticker-avatar-blank">${esc(bName[0] || "?")}</div>`;
          return `
            <div class="ticker-game ${st.cls}">
              <span class="ticker-status">${st.label}</span>
              <span class="ticker-team">
                ${aAvatar}
                <span class="ticker-team-name">${aName}</span>
                <span class="ticker-team-score">${aScore}</span>
              </span>
              <span class="ticker-vs">vs</span>
              <span class="ticker-team">
                <span class="ticker-team-score">${bScore}</span>
                <span class="ticker-team-name">${bName}</span>
                ${bAvatar}
              </span>
            </div>`;
        };
        // Duplicate the list so the CSS marquee loops seamlessly
        const items = pairs.map(p => tickerItem(p[0], p[1])).join("");
        matchupsEl.innerHTML = `
          <div class="ticker-shell">
            <div class="ticker-badge">WEEK ${week}</div>
            <div class="ticker-track-wrap">
              <div class="ticker-track">${items}${items}</div>
            </div>
          </div>`;
      }
    } catch (e) {
      matchupsEl.innerHTML = errBox("Matchups unavailable right now.");
    }

    // Standings — full league

    // Standings snapshot (all teams)
    const ranked = Array.from(teams.values()).sort((a,b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.fpts - a.fpts;
    });
    standingsEl.innerHTML = `
      <table class="stats-table">
        <thead><tr><th>#</th><th>Team</th><th>W-L</th><th class="num">PF</th></tr></thead>
        <tbody>${ranked.map((t, i) => `
          <tr>
            <td class="rank ${i===0?'gold':''}">${i+1}</td>
            <td><div class="team-cell">
              <img class="avatar-sm" src="${esc(avatarUrl(t))}" alt="" onerror="this.src='assets/img/logo.jpg'">
              ${esc(t.team_name)}
            </div></td>
            <td>${t.wins}-${t.losses}${t.ties ? '-'+t.ties : ''}</td>
            <td class="num">${fmt1(t.fpts)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    // Injury alerts + wire top 6 (trending removed per user preference)
    newsEl.innerHTML = `
      <div class="grid" style="grid-template-columns:1fr;gap:30px;">
        <div>
          <div class="section-head" style="margin-bottom:12px;">
            <h2 style="font-size:22px;">Injury alerts</h2>
            <span class="meta">Your rostered players</span>
          </div>
          <div id="home-injuries"></div>
        </div>
        <div>
          <div class="section-head" style="margin-bottom:12px;">
            <h2 style="font-size:22px;">The Wire</h2>
            <span class="meta">Latest headlines</span>
          </div>
          <div id="home-wire"></div>
        </div>
      </div>`;
    renderInjuriesWidget("home-injuries", { limit: 4 });
    renderWire("home-wire",     { limit: 6 });
  } catch (e) {
    heroEl.innerHTML = errBox(`League fetch failed: ${e.message}`);
  }
}

/* ---------- MATCHUPS ---------- */
async function renderMatchups() {
  const container = document.getElementById("matchups-list");
  const controls = document.getElementById("week-controls");
  container.innerHTML = loading("Loading matchups…");

  try {
    const { state, league, teams } = await bootstrap();
    const currentWeek = displayWeek(state, league);
    let selectedWeek = currentWeek;

    // Build week selector (1..17)
    const totalWeeks = 17;
    const select = document.createElement("select");
    for (let w = 1; w <= totalWeeks; w++) {
      const opt = document.createElement("option");
      opt.value = w; opt.textContent = `Week ${w}`;
      if (w === selectedWeek) opt.selected = true;
      select.appendChild(opt);
    }
    const wrap = document.createElement("label");
    wrap.className = "control active";
    wrap.appendChild(select);
    controls.appendChild(wrap);

    async function load(week) {
      container.innerHTML = loading(`Loading week ${week}…`);
      try {
        const m = await getMatchups(week);
        if (!m.length) { container.innerHTML = empty(`No matchups for week ${week}.`); return; }
        const pairs = pairMatchups(m, teams);
        container.innerHTML = `<div class="grid">${
          pairs.map(p => matchupCardHtml(p[0], p[1])).join("")
        }</div>`;
      } catch (e) {
        container.innerHTML = errBox(`Couldn't load week ${week}.`);
      }
    }
    select.addEventListener("change", () => load(Number(select.value)));
    load(selectedWeek);
  } catch (e) {
    container.innerHTML = errBox(e.message);
  }
}

/* ---------- STANDINGS + POWER RANKINGS ---------- */
async function renderStandings() {
  const stEl  = document.getElementById("standings-table");
  const prEl  = document.getElementById("power-table");
  stEl.innerHTML = loading();
  prEl.innerHTML = loading("Computing power rankings…");

  try {
    const { state, league, teams } = await bootstrap();
    const week = displayWeek(state, league);

    const rows = Array.from(teams.values()).sort((a,b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.fpts !== a.fpts) return b.fpts - a.fpts;
      return a.fpts_against - b.fpts_against;
    });
    stEl.innerHTML = `
      <table class="stats-table">
        <thead><tr>
          <th>#</th><th>Team</th><th>W-L-T</th>
          <th class="num">PF</th><th class="num">PA</th><th class="num">Diff</th>
        </tr></thead>
        <tbody>${rows.map((t, i) => `
          <tr>
            <td class="rank ${i===0?'gold':''}">${i+1}</td>
            <td><div class="team-cell">
              <img class="avatar-sm" src="${esc(avatarUrl(t))}" alt="" onerror="this.src='assets/img/logo.jpg'">
              ${esc(t.team_name)}
            </div></td>
            <td>${t.wins}-${t.losses}-${t.ties}</td>
            <td class="num">${fmt1(t.fpts)}</td>
            <td class="num">${fmt1(t.fpts_against)}</td>
            <td class="num">${fmt1(t.fpts - t.fpts_against)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    // Power rankings — need matchup history
    const power = await computePowerRankings(teams, week);
    prEl.innerHTML = `
      <table class="stats-table">
        <thead><tr>
          <th>#</th><th>Team</th><th class="num">Power</th><th class="num">Form</th>
        </tr></thead>
        <tbody>${power.map((t, i) => `
          <tr>
            <td class="rank ${i===0?'gold':''}">${i+1}</td>
            <td><div class="team-cell">
              <img class="avatar-sm" src="${esc(avatarUrl(t))}" alt="" onerror="this.src='assets/img/logo.jpg'">
              ${esc(t.team_name)}
            </div></td>
            <td class="num">${fmt1(t.power)}</td>
            <td class="num">${fmt2(t.form)}×</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p style="font-family:var(--f-sign);letter-spacing:1px;color:var(--brown);font-size:13px;margin-top:12px;">
        Power = 60% win rate + 25% points-for percentile + 15% recent form.
      </p>`;
  } catch (e) {
    stEl.innerHTML = errBox(e.message);
  }
}

/* ---------- NEWS: The Wire (RSS aggregation) ---------- */
function wireItemHtml(item) {
  return `
    <div class="wire-item">
      <div class="source ${esc(item.source)}">${esc(item.source)}</div>
      <div>
        <h3><a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a></h3>
        ${item.description ? `<p>${esc(item.description)}</p>` : ""}
      </div>
      <div class="when">${esc(relTime(item.pubDate))}</div>
    </div>`;
}

/* Module-level cache so modal can access items after render */
let _wireItemsBySource = new Map();

function groupBySource(items) {
  const groups = new Map();
  items.forEach(item => {
    const src = item.source || "UNKNOWN";
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src).push(item);
  });
  // Sort each group's items newest first (defensive — they're mostly sorted already)
  groups.forEach(list => list.sort((a, b) => (b.ts || 0) - (a.ts || 0)));
  return groups;
}

function sourceCardHtml(source, items) {
  const recent = items.slice(0, 3);
  const total24h = items.filter(i => (Date.now() - (i.ts || 0)) < 24*60*60*1000).length;
  return `
    <div class="source-card">
      <div class="source-card-head">
        <span class="source ${esc(source)}">${esc(source)}</span>
        <span class="source-count">${total24h} in last 24h</span>
      </div>
      <div class="source-card-body">
        ${recent.map(item => `
          <div class="source-card-item">
            <a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a>
            <div class="source-card-when">${esc(relTime(item.pubDate))}</div>
          </div>`).join("")}
      </div>
      ${total24h > recent.length
        ? `<button class="source-see-all" data-source="${esc(source)}">
             See all ${total24h} from last 24h →
           </button>`
        : ""}
    </div>`;
}

function openWireModal(source) {
  const items = (_wireItemsBySource.get(source) || [])
    .filter(i => (Date.now() - (i.ts || 0)) < 24*60*60*1000);

  // Remove any existing modal
  const existing = document.getElementById("wire-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "wire-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-head">
        <div>
          <span class="source ${esc(source)}">${esc(source)}</span>
          <span class="modal-count">${items.length} items in last 24 hours</span>
        </div>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        ${items.length ? items.map(item => `
          <div class="wire-item">
            <div class="source ${esc(item.source)}">${esc(item.source)}</div>
            <div>
              <h3><a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.title)}</a></h3>
              ${item.description ? `<p>${esc(item.description)}</p>` : ""}
            </div>
            <div class="when">${esc(relTime(item.pubDate))}</div>
          </div>
        `).join("") : `<div class="state">No items in the last 24 hours.</div>`}
      </div>
    </div>`;

  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";

  const close = () => {
    modal.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  modal.querySelector(".modal-close").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", onKey);
}

async function renderWire(containerId, { limit = null, categorized = false } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = loading("Pulling the wire…");

  const NON_NFL_RE = /\b(nba|mlb|mls|nhl|mma|ufc|pga|lpga|nascar|f1|wnba|soccer|epl|premier league|la liga|serie a|bundesliga|champions league|cricket|tennis|atp|wta|indycar|boxing|wwe|hockey|baseball|basketball)\b/i;
  const isNfl = (it) => !NON_NFL_RE.test(`${it.title || ''} ${it.description || ''}`);

  try {
    const [wireResult, fpResult, espnResult] = await Promise.allSettled([
      getWireStatic(),
      getFantasyProsNews(),
      getEspnNews(),
    ]);
    const wire = wireResult.status === "fulfilled" ? (wireResult.value.items || []) : [];
    const fp   = fpResult.status   === "fulfilled" ? fpResult.value : [];
    const espn = espnResult.status === "fulfilled"
      ? espnResult.value.map(a => ({
          title: a.headline || "",
          link: a.link || "#",
          description: a.description || "",
          pubDate: a.published || "",
          ts: a.published ? new Date(a.published).getTime() : 0,
          source: "ESPN",
        })).filter(isNfl)
      : [];
    const items = [...wire, ...fp, ...espn].sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if (!items.length) {
      el.innerHTML = empty("The wire is quiet right now. If you just deployed, the first fetch runs within 15 minutes.");
      return;
    }

    if (categorized) {
      // Group by source, render one card per source
      _wireItemsBySource = groupBySource(items);

      // Preferred display order — pin important ones first, others alphabetical
      const priority = ["ESPN", "FANTASYPROS", "PFT", "ROTOWIRE", "ROTOBALLER", "PFF", "R-NFL", "R-FF"];
      const sources = Array.from(_wireItemsBySource.keys()).sort((a, b) => {
        const pa = priority.indexOf(a), pb = priority.indexOf(b);
        if (pa !== -1 && pb !== -1) return pa - pb;
        if (pa !== -1) return -1;
        if (pb !== -1) return 1;
        return a.localeCompare(b);
      });

      el.innerHTML = `<div class="source-grid">${
        sources.map(src => sourceCardHtml(src, _wireItemsBySource.get(src))).join("")
      }</div>`;

      // Wire up "See all" buttons
      el.querySelectorAll(".source-see-all").forEach(btn => {
        btn.addEventListener("click", () => openWireModal(btn.dataset.source));
      });
    } else {
      // Legacy compact list for the home page
      const show = limit ? items.slice(0, limit) : items;
      el.innerHTML = show.map(wireItemHtml).join("");
    }
  } catch (e) {
    el.innerHTML = errBox("Wire is down. Try again in a bit.");
  }
}

/* ---------- NEWS: Trending on Sleeper ---------- */
function trendingItemHtml(entry, rank, playerDb) {
  const p = playerDb[entry.player_id] || {};
  const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Player ${entry.player_id}`;
  const pos  = p.position || "";
  const team = p.team || "FA";
  return `
    <div class="trending-item">
      <div class="rank">${rank}</div>
      <div>
        <div class="player">${esc(name)}</div>
        <div class="meta">${esc(pos)} • ${esc(team)}</div>
      </div>
      <div class="count">
        ${entry.count.toLocaleString()}
        <small>adds</small>
      </div>
    </div>`;
}

async function renderTrending(containerId, { limit = null } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = loading("Loading trending adds…");
  try {
    const cfg = window.Config || {};
    const [entries, players] = await Promise.all([
      getSleeperTrending("add", cfg.TRENDING_HOURS || 24, cfg.TRENDING_LIMIT || 25),
      getPlayers(),
    ]);
    if (!entries.length) {
      el.innerHTML = empty("No trending activity right now.");
      return;
    }
    const show = limit ? entries.slice(0, limit) : entries;
    el.innerHTML = `<div class="trending-list">${
      show.map((e, i) => trendingItemHtml(e, i + 1, players)).join("")
    }</div>`;
  } catch (e) {
    el.innerHTML = errBox("Couldn't reach Sleeper trending.");
  }
}

/* ---------- NEWS: The Insiders (X embeds) ---------- */
function loadTwitterScript() {
  return new Promise((resolve) => {
    if (window.twttr && window.twttr.widgets) {
      resolve(window.twttr);
      return;
    }
    if (document.getElementById("twitter-wjs")) {
      // Script exists; poll briefly for twttr readiness
      const start = Date.now();
      const check = setInterval(() => {
        if (window.twttr && window.twttr.widgets) {
          clearInterval(check);
          resolve(window.twttr);
        } else if (Date.now() - start > 15000) {
          clearInterval(check);
          resolve(null);
        }
      }, 200);
      return;
    }
    const s = document.createElement("script");
    s.id = "twitter-wjs";
    s.async = true;
    s.src = "https://platform.twitter.com/widgets.js";
    s.onload = () => {
      // Twitter's script defines twttr.ready() for post-load callbacks
      if (window.twttr && typeof window.twttr.ready === "function") {
        window.twttr.ready((tw) => resolve(tw));
      } else if (window.twttr && window.twttr.widgets) {
        resolve(window.twttr);
      } else {
        // Poll for late attachment
        const start = Date.now();
        const check = setInterval(() => {
          if (window.twttr && window.twttr.widgets) {
            clearInterval(check);
            resolve(window.twttr);
          } else if (Date.now() - start > 10000) {
            clearInterval(check);
            resolve(null);
          }
        }, 200);
      }
    };
    s.onerror = () => resolve(null);
    document.body.appendChild(s);
  });
}

function renderInsiders(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const handles = (window.Config && window.Config.X_HANDLES) || [];
  if (!handles.length) { el.innerHTML = empty("No insiders configured."); return; }

  el.innerHTML = `<div class="insiders-grid">${handles.map(h => `
    <div class="insider-tile">
      <div class="insider-head">
        <span class="name">${esc(h.name)}</span>
        <span class="outlet">${esc(h.outlet)}</span>
      </div>
      <div class="twitter-timeline-wrap">
        <a class="twitter-timeline"
           data-height="500"
           data-theme="light"
           data-chrome="noheader nofooter noborders transparent"
           data-tweet-limit="5"
           data-dnt="true"
           href="https://twitter.com/${esc(h.handle)}?ref_src=twsrc%5Etfw">
          <span class="fallback">
            Loading @${esc(h.handle)}…
            <br><a href="https://twitter.com/${esc(h.handle)}" target="_blank" rel="noopener">Open on X ↗</a>
          </span>
        </a>
      </div>
    </div>`).join("")}</div>`;

  // Load X widgets script then explicitly trigger a scan of our container
  loadTwitterScript().then((twttr) => {
    if (twttr && twttr.widgets && typeof twttr.widgets.load === "function") {
      try { twttr.widgets.load(el); } catch (_) { /* swallow */ }
    } else {
      // Widgets never loaded — show clearer fallback message
      const wraps = el.querySelectorAll(".twitter-timeline-wrap");
      wraps.forEach(w => {
        // If the anchor is still there un-rendered, replace with a follow card
        const anchor = w.querySelector("a.twitter-timeline");
        if (anchor) {
          const href = anchor.getAttribute("href").split("?")[0];
          const handle = href.split("/").pop();
          w.innerHTML = `
            <div class="insider-followcard">
              <p>X's embed didn't load. Their live feed is one click away:</p>
              <a href="${esc(href)}" target="_blank" rel="noopener" class="control active">
                Open @${esc(handle)} on X ↗
              </a>
            </div>`;
        }
      });
    }
  });
}

/* ---------- NEWS page: orchestrates all three sections ---------- */
async function renderNews() {
  // The Wire in categorized mode — one card per source
  renderWire("wire-list", { categorized: true });
  // Trending and Insiders removed per user preference

  // Feature stories — top 3 recent, click to see more
  const listEl = document.getElementById("news-list");
  if (!listEl) return;
  listEl.innerHTML = loading("Fetching feature stories…");

  let articles = [];
  let rosteredSet = null;
  let filterRostered = false;
  let expanded = false;
  const filterEl = document.getElementById("news-filter");

  const paint = () => {
    const source = filterRostered
      ? articles.filter(a => articleTouchesRoster(a, rosteredSet))
      : articles;
    if (!source.length) {
      listEl.innerHTML = empty(filterRostered ? "No features touching a rostered player right now." : "No features available.");
      return;
    }
    const show = expanded ? source : source.slice(0, 3);
    const remaining = source.length - show.length;

    listEl.innerHTML = show.map(a => {
      const isRostered = rosteredSet && articleTouchesRoster(a, rosteredSet);
      return `
        <div class="article ${isRostered ? 'rostered' : ''}">
          <div class="byline">
            ${isRostered ? '<span class="tag">Rostered</span>' : ''}
            ${esc(a.byline)} • ${esc(relTime(a.published))}
          </div>
          <h3><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.headline)}</a></h3>
          <p>${esc(a.description)}</p>
        </div>`;
    }).join("") + (remaining > 0
      ? `<button class="source-see-all" id="features-expand">Show all ${source.length} features →</button>`
      : "");

    const expandBtn = document.getElementById("features-expand");
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        expanded = true;
        paint();
      });
    }
  };

  try {
    articles = await getEspnNews();
    paint();
  } catch (e) {
    listEl.innerHTML = errBox("Couldn't reach ESPN features.");
    return;
  }

  (async () => {
    try {
      const { rosters } = await bootstrap();
      const players = await getPlayers();
      rosteredSet = rosteredPlayerNames(rosters, players);
      if (filterEl) {
        const btn = document.createElement("button");
        btn.className = "control";
        btn.textContent = "League players only";
        btn.addEventListener("click", () => {
          filterRostered = !filterRostered;
          btn.classList.toggle("active", filterRostered);
          expanded = false;
          paint();
        });
        filterEl.appendChild(btn);
      }
      paint();
    } catch (_) {}
  })();
}

/* ---------- TRANSACTIONS ---------- */
async function renderTransactions() {
  const listEl = document.getElementById("txn-list");
  const controls = document.getElementById("txn-controls");
  listEl.innerHTML = loading();

  try {
    const { state, league, teams } = await bootstrap();
    const players = await getPlayers();
    const currentWeek = displayWeek(state, league);

    const select = document.createElement("select");
    for (let w = 1; w <= currentWeek; w++) {
      const opt = document.createElement("option");
      opt.value = w; opt.textContent = `Week ${w}`;
      if (w === currentWeek) opt.selected = true;
      select.appendChild(opt);
    }
    const wrap = document.createElement("label");
    wrap.className = "control active";
    wrap.appendChild(select);
    controls.appendChild(wrap);

    async function load(week) {
      listEl.innerHTML = loading();
      try {
        const txns = await getTransactions(week);
        if (!txns.length) { listEl.innerHTML = empty("No moves this week."); return; }
        // sort newest first
        txns.sort((a, b) => (b.status_updated || 0) - (a.status_updated || 0));

        listEl.innerHTML = txns.map(t => {
          const typeLabel = t.type === 'trade' ? 'TRADE'
                          : t.type === 'waiver' ? 'WAIVER' : 'FREE AGT';
          const teamNames = (t.roster_ids || [])
            .map(rid => (teams.get(rid) || {}).team_name || `Team ${rid}`)
            .join(" ↔ ");
          const nameFor = pid => {
            const p = players[pid];
            return p ? `${p.first_name || ''} ${p.last_name || ''} (${p.position || ''}${p.team ? ' – '+p.team : ''})`.trim()
                     : `Player ${pid}`;
          };
          const adds  = t.adds  ? Object.entries(t.adds)  : [];
          const drops = t.drops ? Object.entries(t.drops) : [];

          const movesHtml = [
            ...adds.map(([pid, rid]) => {
              const tm = (teams.get(rid) || {}).team_name || `Team ${rid}`;
              return `<div><span class="team">${esc(tm)}</span> added <span class="add">${esc(nameFor(pid))}</span></div>`;
            }),
            ...drops.map(([pid, rid]) => {
              const tm = (teams.get(rid) || {}).team_name || `Team ${rid}`;
              return `<div><span class="team">${esc(tm)}</span> dropped <span class="drop">${esc(nameFor(pid))}</span></div>`;
            }),
          ].join("");

          const when = t.status_updated
            ? new Date(t.status_updated).toLocaleDateString(undefined, { month:'short', day:'numeric' })
            : "";

          return `
            <div class="txn">
              <div class="type ${esc(t.type)}">${typeLabel}</div>
              <div class="body">
                ${t.type === 'trade' ? `<div class="team">${esc(teamNames)}</div>` : ''}
                ${movesHtml || `<div>${esc(t.status || '')}</div>`}
              </div>
              <div class="when">${esc(when)}</div>
            </div>`;
        }).join("");
      } catch (e) {
        listEl.innerHTML = empty("No moves this week.");
      }
    }
    select.addEventListener("change", () => load(Number(select.value)));
    load(currentWeek);
  } catch (e) {
    listEl.innerHTML = errBox(e.message);
  }
}

/* ---------- HISTORY ---------- */
async function renderHistory() {
  const listEl = document.getElementById("history-list");
  const recordsEl = document.getElementById("records-box");
  listEl.innerHTML = loading("Walking through the archives…");

  try {
    const { league, teams } = await bootstrap();
    const records = {
      highestSingleGame: { pts: 0, team: "—", week: null, season: null },
      lowestSingleGame: { pts: Infinity, team: "—", week: null, season: null },
    };

    // Scan current-league matchups for records
    for (let w = 1; w <= 17; w++) {
      try {
        const m = await getMatchups(w);
        m.forEach(entry => {
          const pts = entry.points || 0;
          if (pts <= 0) return;
          const t = teams.get(entry.roster_id);
          const name = t ? t.team_name : `Team ${entry.roster_id}`;
          if (pts > records.highestSingleGame.pts) {
            records.highestSingleGame = { pts, team: name, week: w, season: league.season };
          }
          if (pts < records.lowestSingleGame.pts) {
            records.lowestSingleGame = { pts, team: name, week: w, season: league.season };
          }
        });
      } catch (_) { break; }  // week past current — stop
    }
    if (records.lowestSingleGame.pts === Infinity) {
      records.lowestSingleGame = { pts: 0, team: "—", week: null, season: null };
    }

    recordsEl.innerHTML = `
      <table class="stats-table">
        <thead><tr><th>Record</th><th>Team</th><th class="num">Value</th><th>When</th></tr></thead>
        <tbody>
          <tr>
            <td>Highest single-game</td>
            <td>${esc(records.highestSingleGame.team)}</td>
            <td class="num">${fmt1(records.highestSingleGame.pts)}</td>
            <td>${records.highestSingleGame.week ? `${esc(records.highestSingleGame.season)} W${records.highestSingleGame.week}` : "—"}</td>
          </tr>
          <tr>
            <td>Lowest single-game</td>
            <td>${esc(records.lowestSingleGame.team)}</td>
            <td class="num">${fmt1(records.lowestSingleGame.pts)}</td>
            <td>${records.lowestSingleGame.week ? `${esc(records.lowestSingleGame.season)} W${records.lowestSingleGame.week}` : "—"}</td>
          </tr>
        </tbody>
      </table>`;

    // Walk previous_league_id chain for champions
    const champions = [];
    let curId = league.league_id;
    let curLeague = league;
    let safety = 20;
    while (curId && safety-- > 0) {
      try {
        // Only try winners bracket if league is completed
        const status = curLeague.status;
        if (status === "complete") {
          const bracket = await getWinnersBracket(curId);
          const final = bracket.find(g => g.r === Math.max(...bracket.map(x => x.r)) && g.m === 1);
          if (final && final.w) {
            const winnerRoster = final.w;
            let winnerName = `Roster ${winnerRoster}`;
            try {
              const users = await getUsers(curId);
              const rosters = await getRosters(curId);
              const tmap = buildTeamMap(users, rosters);
              const t = tmap.get(winnerRoster);
              if (t) winnerName = t.team_name;
            } catch (_) {}
            champions.push({ season: curLeague.season, team: winnerName });
          }
        }
      } catch (_) {}
      curId = curLeague.previous_league_id;
      if (curId) {
        try { curLeague = await getLeague(curId); }
        catch (_) { break; }
      } else {
        break;
      }
    }

    // Hardcoded past champions (pre-Sleeper history), most recent first
    const HISTORICAL_CHAMPIONS = [
      { season: "2025-26", team: "Indiana Jones",  manager: "Andrew Morales",  reigning: true  },
      { season: "2024-25", team: "CeeDees TD's",   manager: "Andry Nunez",     reigning: false },
      { season: "2023-24", team: "Kittle Cookd",   manager: "Keyro Collado",   reigning: false },
      { season: "2022-23", team: "King",           manager: "Jon King",        reigning: false },
      { season: "2021-22", team: "Gaskin For Air", manager: "Adam Morales",    reigning: false },
    ];

    // Any Sleeper-archived champions get merged in (they'll usually be newer than 2024-25)
    const combined = [...champions, ...HISTORICAL_CHAMPIONS];

    if (!combined.length) {
      listEl.innerHTML = empty("No completed seasons on record yet.");
    } else {
      listEl.innerHTML = `
        <div class="champ-wall">
          ${combined.map((c, i) => `
            <div class="champ-card ${c.reigning || i === 0 ? 'reigning' : ''}">
              <div class="champ-trophy">🏆</div>
              <div class="champ-season">${esc(c.season)}</div>
              <div class="champ-team">${esc(c.team)}</div>
              ${c.manager ? `<div class="champ-manager">${esc(c.manager)}</div>` : ''}
              ${c.reigning || i === 0 ? '<div class="champ-badge">Reigning</div>' : ''}
            </div>`).join("")}
        </div>`;
    }
  } catch (e) {
    listEl.innerHTML = errBox(e.message);
  }
}

/* ---------- INJURIES: Sleeper-based, rostered players only ---------- */

/* Severity order: highest impact first */
const INJURY_ORDER = ["Out", "IR", "PUP", "Doubtful", "Sus", "Questionable", "NA"];
const INJURY_CLASS = {
  "Out": "out",
  "IR": "ir",
  "PUP": "pup",
  "Doubtful": "doubtful",
  "Sus": "sus",
  "Questionable": "questionable",
  "NA": "na",
};

function injuryRank(status) {
  const i = INJURY_ORDER.indexOf(status);
  return i === -1 ? 99 : i;
}

/* Build the list of rostered players with injuries, cross-linked to team.
   Also enriches each entry with FantasyPros data (practice reports, prob
   of playing) when available. */
function buildInjuryList(teams, players, fpInjuries) {
  // Index FantasyPros injuries by lowercase name for cross-matching
  const fpByName = new Map();
  if (fpInjuries && fpInjuries.length) {
    fpInjuries.forEach(fp => {
      if (fp.name) fpByName.set(fp.name.toLowerCase(), fp);
    });
  }

  const out = [];
  teams.forEach(team => {
    (team.players || []).forEach(pid => {
      const p = players[pid];
      if (!p) return;
      if (!p.injury_status || p.injury_status === "Healthy") return;

      const nameLower = (p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim()).toLowerCase();
      const fp = fpByName.get(nameLower);

      out.push({
        player_id: pid,
        name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || `Player ${pid}`,
        position: p.position || "",
        nfl_team: p.team || "FA",
        status: p.injury_status,
        body_part: p.injury_body_part || (fp ? fp.injury_type : ""),
        notes: p.injury_notes || (fp ? fp.comment : ""),
        started: p.injury_start_date || "",
        owner: team.team_name || `Team ${team.roster_id}`,
        owner_id: team.roster_id,
        owner_avatar: team.avatar,
        isStarter: (team.starters || []).includes(pid),
        // FantasyPros enrichments
        fp_probability: fp ? fp.probability : null,
        fp_update_date: fp ? fp.update_date : "",
        fp_practice_1: fp ? fp.practice_1 : "",
        fp_practice_2: fp ? fp.practice_2 : "",
        fp_practice_3: fp ? fp.practice_3 : "",
      });
    });
  });
  out.sort((a, b) => {
    const ra = injuryRank(a.status), rb = injuryRank(b.status);
    if (ra !== rb) return ra - rb;
    return a.owner.localeCompare(b.owner);
  });
  return out;
}

function injuryCardHtml(entry) {
  const cls = INJURY_CLASS[entry.status] || "questionable";
  const starterBadge = entry.isStarter ? '<span class="starter-tag">STARTER</span>' : "";

  // FantasyPros probability of playing (0-1 → %)
  const probHtml = entry.fp_probability != null
    ? `<span class="injury-prob">${Math.round(entry.fp_probability * 100)}% to play</span>`
    : "";

  // Practice report (W/Th/F participation)
  const practices = [entry.fp_practice_1, entry.fp_practice_2, entry.fp_practice_3].filter(Boolean);
  const practiceHtml = practices.length
    ? `<div class="injury-practice">Practice: ${practices.map(esc).join(" → ")}</div>`
    : "";

  return `
    <div class="injury-card ${cls}">
      <div class="injury-status ${cls}">${esc(entry.status)}</div>
      <div class="injury-body">
        <div class="injury-line1">
          <span class="injury-player">${esc(entry.name)}</span>
          <span class="injury-meta">${esc(entry.position)} • ${esc(entry.nfl_team)}</span>
          ${starterBadge}
          ${probHtml}
        </div>
        <div class="injury-line2">
          <span class="injury-owner">Rostered by ${esc(entry.owner)}</span>
          ${entry.body_part ? `<span class="injury-part">${esc(entry.body_part)}</span>` : ""}
        </div>
        ${entry.notes ? `<div class="injury-notes">${esc(entry.notes)}</div>` : ""}
        ${practiceHtml}
      </div>
    </div>`;
}

/* Build a list from FantasyPros injuries when no league roster context needed */
function buildAllNflInjuryList(fpInjuries) {
  if (!fpInjuries || !fpInjuries.length) return [];
  return fpInjuries.map(fp => ({
    player_id: fp.player_id,
    name: fp.name,
    position: fp.position,
    nfl_team: fp.team,
    status: fp.status,
    body_part: fp.injury_type || fp.practice_report_injury_type || "",
    notes: fp.comment || "",
    started: "",
    owner: "",
    owner_id: null,
    isStarter: false,
    fp_probability: fp.probability,
    fp_update_date: fp.update_date,
    fp_practice_1: fp.practice_1,
    fp_practice_2: fp.practice_2,
    fp_practice_3: fp.practice_3,
  })).sort((a, b) => {
    const ra = injuryRank(a.status), rb = injuryRank(b.status);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

async function renderInjuries() {
  const summaryEl = document.getElementById("injury-summary");
  const listEl = document.getElementById("injury-list");
  const filtersEl = document.getElementById("injury-filters");
  if (summaryEl) summaryEl.innerHTML = loading("Building injury report…");
  if (listEl) listEl.innerHTML = "";

  try {
    const { teams } = await bootstrap();
    const [players, fpInjuries] = await Promise.all([
      getPlayers(),
      getFantasyProsInjuries().catch(() => []),
    ]);

    const leagueList = buildInjuryList(teams, players, fpInjuries);
    const allNflList = buildAllNflInjuryList(fpInjuries);

    // Pre-draft detection: kept for reference but user prefers All NFL always
    let hasAnyRosterPlayers = false;
    teams.forEach(t => { if ((t.players || []).length) hasAnyRosterPlayers = true; });
    const preDraft = !hasAnyRosterPlayers;

    // Mode: "league" | "all" — default to All NFL so all injuries are visible
    let mode = "all";
    let filterStatus = null;
    let filterStartersOnly = false;

    const activeList = () => {
      let list = mode === "league" ? leagueList : allNflList;
      if (filterStatus) list = list.filter(i => i.status === filterStatus);
      if (filterStartersOnly && mode === "league") list = list.filter(i => i.isStarter);
      return list;
    };

    const paintSummary = () => {
      if (!summaryEl) return;
      const list = mode === "league" ? leagueList : allNflList;
      const counts = {};
      list.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
      const order = INJURY_ORDER.filter(s => counts[s]);
      if (!order.length) {
        summaryEl.innerHTML = "";
        return;
      }
      summaryEl.innerHTML = `
        <div class="injury-summary-grid">
          ${order.map(s => `
            <div class="injury-tile ${INJURY_CLASS[s] || 'questionable'}">
              <div class="injury-tile-num">${counts[s]}</div>
              <div class="injury-tile-label">${esc(s)}</div>
            </div>`).join("")}
        </div>`;
    };

    const paintList = () => {
      const list = activeList();
      if (!list.length) {
        if (mode === "league") {
          if (preDraft) {
            listEl.innerHTML = empty("No rostered players yet — draft hasn't happened. Switch to 'All NFL' above to see the full league injury report.");
          } else if (!leagueList.length) {
            listEl.innerHTML = empty("No injuries on rostered players. Good week.");
          } else {
            listEl.innerHTML = empty("No injuries match this filter.");
          }
        } else {
          listEl.innerHTML = empty("No NFL injuries in FantasyPros feed right now.");
        }
        return;
      }
      listEl.innerHTML = list.map(injuryCardHtml).join("");
    };

    const paintFilters = () => {
      if (!filtersEl) return;
      filtersEl.innerHTML = "";

      // Mode toggle
      ["league", "all"].forEach(m => {
        const btn = document.createElement("button");
        btn.className = "control" + (mode === m ? " active" : "");
        btn.textContent = m === "league" ? "League only" : "All NFL";
        btn.style.marginRight = "6px";
        btn.addEventListener("click", () => {
          mode = m;
          filterStatus = null;
          filterStartersOnly = false;
          paintFilters();
          paintSummary();
          paintList();
        });
        filtersEl.appendChild(btn);
      });

      // Separator
      const sep = document.createElement("span");
      sep.style.cssText = "display:inline-block;width:1px;background:var(--navy);height:20px;margin:0 10px;vertical-align:middle;";
      filtersEl.appendChild(sep);

      // Status filters
      const list = mode === "league" ? leagueList : allNflList;
      const counts = {};
      list.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });

      const allBtn = document.createElement("button");
      allBtn.className = "control" + (filterStatus === null ? " active" : "");
      allBtn.textContent = "All";
      allBtn.addEventListener("click", () => {
        filterStatus = null;
        paintFilters();
        paintList();
      });
      filtersEl.appendChild(allBtn);

      INJURY_ORDER.filter(s => counts[s]).forEach(s => {
        const btn = document.createElement("button");
        btn.className = "control" + (filterStatus === s ? " active" : "");
        btn.textContent = `${s} (${counts[s]})`;
        btn.addEventListener("click", () => {
          filterStatus = s;
          paintFilters();
          paintList();
        });
        filtersEl.appendChild(btn);
      });

      // Starters-only (only relevant in league mode)
      if (mode === "league" && !preDraft) {
        const starterBtn = document.createElement("button");
        starterBtn.className = "control" + (filterStartersOnly ? " active" : "");
        starterBtn.textContent = "Starters only";
        starterBtn.style.marginLeft = "10px";
        starterBtn.addEventListener("click", () => {
          filterStartersOnly = !filterStartersOnly;
          paintFilters();
          paintList();
        });
        filtersEl.appendChild(starterBtn);
      }
    };

    paintFilters();
    paintSummary();
    paintList();
  } catch (e) {
    if (summaryEl) summaryEl.innerHTML = errBox(e.message);
  }
}

/* Small home widget: top N most severe injuries on rostered starters */
async function renderInjuriesWidget(containerId, { limit = 5 } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = loading("Loading injuries…");
  try {
    const { teams } = await bootstrap();
    const [players, fpInjuries] = await Promise.all([
      getPlayers(),
      getFantasyProsInjuries().catch(() => []),
    ]);
    const injuries = buildInjuryList(teams, players, fpInjuries);
    const sorted = [...injuries].sort((a, b) => {
      if (a.isStarter !== b.isStarter) return a.isStarter ? -1 : 1;
      return injuryRank(a.status) - injuryRank(b.status);
    });
    const show = sorted.slice(0, limit);
    if (!show.length) { el.innerHTML = empty("No injuries. Rare good news."); return; }
    el.innerHTML = show.map(injuryCardHtml).join("");
  } catch (e) {
    el.innerHTML = errBox("Couldn't build injury widget.");
  }
}

/* ---------- DRAFT KIT (FantasyPros HOF exclusively) ---------- */

/* Safe number formatter — FP sometimes returns numeric fields as strings.
   Coerce first, then format. Returns '—' for anything that isn't a real number. */
function toFix(v, d) {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(d != null ? d : 1) : '—';
}
function toNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function _pillClass(pos) {
  return `pos-pill pos-${(pos || 'FLEX').toLowerCase()}`;
}

/* Player card for the draft board */
function draftCardHtml(row) {
  const bye = row.bye ? `<span class="dk-bye">BYE ${esc(row.bye)}</span>` : '';
  const posRankBadge = row.pos_rank ? `<span class="dk-pos-rank">${esc(row.pos_rank)}</span>` : '';
  const adpNum = toNum(row.adp);
  const rankNum = toNum(row.rank);
  const adpDelta = (adpNum != null && rankNum != null)
    ? Math.round(adpNum) - rankNum
    : null;
  const adpBadge = adpDelta !== null && Math.abs(adpDelta) >= 3
    ? `<span class="rank-delta ${adpDelta > 0 ? 'up' : 'down'}">${adpDelta > 0 ? '+' : ''}${adpDelta}</span>`
    : '';

  return `
    <div class="dk-card" data-name="${esc((row.name || '').toLowerCase())}">
      <div class="dk-rank">${row.rank ?? '—'}</div>
      <div class="dk-info">
        <div class="dk-name">${esc(row.name)}</div>
        <div class="dk-meta">
          <span class="${_pillClass(row.pos)}">${esc(row.pos)}</span>
          ${posRankBadge}
          <span class="dk-team">${esc(row.team)}</span>
          ${bye}
        </div>
      </div>
      <div class="dk-stats">
        <div class="dk-stat"><span class="lbl">ADP</span><span class="val">${toFix(row.adp)} ${adpBadge}</span></div>
        <div class="dk-stat"><span class="lbl">Proj</span><span class="val proj">${row.proj_pts != null ? Math.round(toNum(row.proj_pts)) : '—'}</span></div>
        <div class="dk-stat"><span class="lbl">Tier</span><span class="val">${row.tier ?? '—'}</span></div>
        <div class="dk-stat"><span class="lbl">Best</span><span class="val gold">${row.best_rank ?? '—'}</span></div>
        <div class="dk-stat"><span class="lbl">Worst</span><span class="val">${row.worst_rank ?? '—'}</span></div>
        <div class="dk-stat"><span class="lbl">Std</span><span class="val">${toFix(row.std_dev)}</span></div>
      </div>
    </div>`;
}

/* Group by FantasyPros tiers when available, otherwise 12-per-round */
function groupIntoTiers(rows) {
  const hasFpTiers = rows.some(r => r.tier != null);
  if (hasFpTiers) {
    const byTier = new Map();
    rows.forEach(r => {
      const t = r.tier || 99;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(r);
    });
    return [...byTier.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tier, players]) => {
        const first = players[0].rank;
        const last = players[players.length - 1].rank;
        return {
          tier,
          label: `Tier ${tier} • ${players.length} player${players.length > 1 ? 's' : ''} • Ranks ${first}–${last}`,
          players,
        };
      });
  }
  const tiers = [];
  for (let i = 0; i < rows.length; i += 12) {
    const tierNum = Math.floor(i / 12) + 1;
    tiers.push({
      tier: tierNum,
      label: `Tier ${tierNum} • Picks ${i + 1}–${Math.min(i + 12, rows.length)}`,
      players: rows.slice(i, i + 12),
    });
  }
  return tiers;
}

function renderDraftBoard(rows) {
  if (!rows.length) return empty("No players in this view.");
  const tiers = groupIntoTiers(rows);
  return tiers.map(tier => `
    <div class="dk-tier">
      <div class="dk-tier-band">
        <span class="dk-tier-num">${tier.tier}</span>
        <span class="dk-tier-label">${esc(tier.label)}</span>
      </div>
      <div class="dk-cards">
        ${tier.players.map(p => draftCardHtml(p)).join("")}
      </div>
    </div>`).join("");
}

async function renderDraftKit() {
  const boardEl     = document.getElementById("dk-board");
  const controlsEl  = document.getElementById("dk-controls");
  const adpEl       = document.getElementById("dk-adp");
  const sleepersEl  = document.getElementById("dk-sleepers");
  const bustsEl     = document.getElementById("dk-busts");
  const vbdEl       = document.getElementById("dk-vbd");
  const handcuffsEl = document.getElementById("dk-handcuffs");
  const quicknavEl  = document.getElementById("dk-quicknav");
  const metaEl      = document.getElementById("dk-meta");
  if (boardEl) boardEl.innerHTML = loading("Loading Draft Kit…");

  try {
    const dk = await getDraftKit();
    const positions = ["overall", "QB", "RB", "WR", "TE", "K", "DST"];

    // Meta line
    const fetched = dk.fetched_at ? new Date(dk.fetched_at) : null;
    const totalPlayers = (dk._summary && dk._summary.overall) || 0;
    if (metaEl) {
      metaEl.textContent = `${totalPlayers} players ranked${fetched ? ' • updated ' + relTime(fetched.toISOString()) : ''} • FantasyPros HOF • ${dk.scoring || 'PPR'}`;
    }

    // Quick nav — sticky anchor bar
    if (quicknavEl) {
      const links = [
        { id: 'sec-board',     label: 'Board' },
        { id: 'sec-vbd',       label: 'VBD' },
        { id: 'sec-sleepers',  label: 'Sleepers' },
        { id: 'sec-busts',     label: 'Busts' },
        { id: 'sec-handcuffs', label: 'Handcuffs' },
        { id: 'sec-values',    label: 'Values' },
      ];
      quicknavEl.innerHTML = links.map(l =>
        `<a href="#${l.id}" class="dk-nav-link">${l.label}</a>`
      ).join("");
    }

    // ========== BOARD (position tabs + tiers) ==========
    let activePos = "overall";
    let searchTerm = "";

    const buildRows = () => {
      let rows = (dk.rankings && dk.rankings[activePos]) || [];
      // "All" tab excludes K and DST (skill positions only)
      if (activePos === "overall") {
        rows = rows.filter(r => r.pos && !["K", "DST"].includes(r.pos));
      }
      if (searchTerm) {
        const t = searchTerm.toLowerCase();
        rows = rows.filter(r => (r.name || '').toLowerCase().includes(t));
      }
      return rows;
    };

    const posCount = (pos) => {
      if (!dk.rankings || !dk.rankings[pos]) return 0;
      if (pos === "overall") {
        return dk.rankings[pos].filter(r => r.pos && !["K", "DST"].includes(r.pos)).length;
      }
      return dk.rankings[pos].length;
    };

    controlsEl.innerHTML = `
      <div class="dk-tabs">
        ${positions.map(pos => `
          <button class="dk-tab ${pos === activePos ? 'active' : ''} dk-tab-${pos.toLowerCase()}" data-pos="${pos}">
            <span class="dk-tab-label">${pos === "overall" ? "All" : pos}</span>
            <span class="dk-tab-count">${posCount(pos)}</span>
          </button>`).join("")}
      </div>
      <div class="dk-search">
        <input type="search" id="dk-search-input" placeholder="Search player name…" autocomplete="off">
      </div>`;

    const paintBoard = () => {
      boardEl.innerHTML = renderDraftBoard(buildRows());
    };

    controlsEl.querySelectorAll(".dk-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        activePos = btn.dataset.pos;
        controlsEl.querySelectorAll(".dk-tab").forEach(b => b.classList.toggle("active", b === btn));
        paintBoard();
      });
    });

    const searchInput = document.getElementById("dk-search-input");
    if (searchInput) {
      let debounce;
      searchInput.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          searchTerm = searchInput.value.trim();
          paintBoard();
        }, 150);
      });
    }

    paintBoard();

    // ========== VBD (Value Based Drafting) ==========
    // Baselines for 12-team full PPR:
    //   QB=QB12, RB=RB30 (incl flex), WR=WR36 (incl flex), TE=TE12, K=K12, DST=DST12
    const BASELINES = { QB: 12, RB: 30, WR: 36, TE: 12, K: 12, DST: 12 };

    const getBaselineProj = (pos) => {
      const arr = (dk.rankings[pos] || [])
        .map(p => toNum(p.proj_pts))
        .filter(n => n != null)
        .sort((a, b) => b - a);
      const idx = (BASELINES[pos] || 12) - 1;
      return arr[idx] != null ? arr[idx] : (arr.length ? arr[arr.length - 1] : 0);
    };

    const baselines = {
      QB:  getBaselineProj("QB"),
      RB:  getBaselineProj("RB"),
      WR:  getBaselineProj("WR"),
      TE:  getBaselineProj("TE"),
      K:   getBaselineProj("K"),
      DST: getBaselineProj("DST"),
    };

    const vbdRows = (dk.rankings.overall || [])
      .map(r => {
        const pts = toNum(r.proj_pts);
        const base = baselines[r.pos] || 0;
        return { ...r, _vbd: (pts != null && base != null) ? pts - base : null, _proj: pts };
      })
      .filter(r => r._vbd != null)
      .sort((a, b) => b._vbd - a._vbd)
      .slice(0, 100);

    if (vbdRows.length) {
      vbdEl.innerHTML = `
        <div class="dk-baseline-strip">
          ${Object.entries(baselines).map(([pos, val]) =>
            `<div class="dk-baseline-item">
               <span class="${_pillClass(pos)}">${pos}</span>
               <span class="dk-baseline-val">${val ? Math.round(val) : '—'}</span>
             </div>`).join("")}
        </div>
        <p class="dk-note dk-baseline-note">
          VBD = projected points − position baseline. Baselines above are the projected points
          of the last startable player at each position in a 12-team full-PPR league
          (QB12, RB30, WR36, TE12, K12, DST12).
        </p>
        <div class="dk-cards">
          ${vbdRows.slice(0, 60).map((r, i) => `
            <div class="dk-card dk-vbd-card">
              <div class="dk-rank dk-vbd-rank">${i + 1}</div>
              <div class="dk-info">
                <div class="dk-name">${esc(r.name)}</div>
                <div class="dk-meta">
                  <span class="${_pillClass(r.pos)}">${esc(r.pos)}</span>
                  <span class="dk-team">${esc(r.team)}</span>
                  ${r.bye ? `<span class="dk-bye">BYE ${esc(r.bye)}</span>` : ''}
                  <span class="dk-fp">ECR ${r.rank ?? '—'}</span>
                </div>
              </div>
              <div class="dk-stats">
                <div class="dk-stat"><span class="lbl">VBD</span><span class="val gold">${Math.round(r._vbd)}</span></div>
                <div class="dk-stat"><span class="lbl">Proj</span><span class="val proj">${r._proj != null ? Math.round(r._proj) : '—'}</span></div>
                <div class="dk-stat"><span class="lbl">Base</span><span class="val">${Math.round(baselines[r.pos] || 0)}</span></div>
                <div class="dk-stat"><span class="lbl">ADP</span><span class="val">${toFix(r.adp)}</span></div>
              </div>
            </div>`).join("")}
        </div>`;
    } else {
      vbdEl.innerHTML = empty("VBD needs projection data. If this stays empty, check the workflow logs.");
    }

    // ========== SLEEPERS (CSV-driven, position tabs) ==========
    const sleeperPositions = ["QB", "RB", "WR", "TE"];
    let sleeperActivePos = "RB";

    const paintSleepers = async () => {
      sleepersEl.innerHTML = `
        <div class="dk-sub-tabs">
          ${sleeperPositions.map(p => `
            <button class="dk-sub-tab ${p === sleeperActivePos ? 'active' : ''} dk-sub-tab-${p.toLowerCase()}" data-pos="${p}">
              ${p}
            </button>`).join("")}
        </div>
        <div id="dk-sleepers-body">${loading("Loading sleepers…")}</div>`;

      sleepersEl.querySelectorAll(".dk-sub-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          sleeperActivePos = btn.dataset.pos;
          paintSleepers();
        });
      });

      const body = document.getElementById("dk-sleepers-body");
      const result = await getFpSleepers(sleeperActivePos);
      if (!result.hasData) {
        body.innerHTML = empty(`No ${sleeperActivePos} sleepers uploaded yet. Add ${'`'}sleepers-${sleeperActivePos.toLowerCase()}.csv${'`'} to assets/data/fp-csv/.`);
        return;
      }
      body.innerHTML = `
        <div class="dk-cards">
          ${result.rows.map(r => `
            <div class="dk-card dk-sleeper">
              <div class="dk-rank">${r.rank ?? '—'}</div>
              <div class="dk-info">
                <div class="dk-name">${esc(r.name)}</div>
                <div class="dk-meta">
                  <span class="${_pillClass(r.pos)}">${esc(r.pos)}</span>
                  <span class="dk-team">${esc(r.team)}</span>
                  ${r.bye ? `<span class="dk-bye">BYE ${esc(r.bye)}</span>` : ''}
                  ${r.experts ? `<span class="dk-fp">${r.experts} expert${r.experts > 1 ? 's' : ''}</span>` : ''}
                </div>
              </div>
              <div class="dk-stats">
                <div class="dk-stat"><span class="lbl">ECR</span><span class="val">${r.ecr ?? '—'}</span></div>
                <div class="dk-stat"><span class="lbl">ADP</span><span class="val">${r.adp ?? '—'}</span></div>
                ${r.tier ? `<div class="dk-stat"><span class="lbl">Tier</span><span class="val">${r.tier}</span></div>` : ''}
              </div>
            </div>`).join("")}
        </div>
        <p class="dk-note">
          Consensus sleepers from FantasyPros HOF experts. Updated weekly via CSV upload.
        </p>`;
    };
    paintSleepers();

    // ========== BUSTS (CSV-driven, position tabs) ==========
    let bustActivePos = "ALL";

    const paintBusts = async () => {
      const result = await getFpBusts();
      if (!result.hasData) {
        bustsEl.innerHTML = empty("No busts CSV uploaded yet. Add busts.csv to assets/data/fp-csv/.");
        return;
      }
      // Get unique positions present in the data
      const posesInData = Array.from(new Set(result.rows.map(r => r.pos)));
      const bustPositions = ["ALL", ...["RB", "WR", "QB", "TE"].filter(p => posesInData.includes(p))];
      // If active pos no longer in data, reset to ALL
      if (bustActivePos !== "ALL" && !posesInData.includes(bustActivePos)) {
        bustActivePos = "ALL";
      }
      const filtered = bustActivePos === "ALL"
        ? result.rows
        : result.rows.filter(r => r.pos === bustActivePos);

      bustsEl.innerHTML = `
        <div class="dk-sub-tabs">
          ${bustPositions.map(p => `
            <button class="dk-sub-tab ${p === bustActivePos ? 'active' : ''} ${p !== 'ALL' ? 'dk-sub-tab-' + p.toLowerCase() : ''}" data-pos="${p}">
              ${p === "ALL" ? "All" : p}
              <span class="dk-sub-tab-count">${p === "ALL" ? result.rows.length : result.rows.filter(r => r.pos === p).length}</span>
            </button>`).join("")}
        </div>
        <div class="dk-cards">
          ${filtered.map(r => `
            <div class="dk-card dk-bust">
              <div class="dk-rank">${r.rank ?? '—'}</div>
              <div class="dk-info">
                <div class="dk-name">${esc(r.name)}</div>
                <div class="dk-meta">
                  <span class="${_pillClass(r.pos)}">${esc(r.pos)}</span>
                  <span class="dk-team">${esc(r.team)}</span>
                </div>
              </div>
              <div class="dk-stats">
                <div class="dk-stat"><span class="lbl">Rank</span><span class="val">${r.rank ?? '—'}</span></div>
                <div class="dk-stat"><span class="lbl">ADP</span><span class="val">${r.adp ?? '—'}</span></div>
                <div class="dk-stat"><span class="lbl">vs ADP</span><span class="val down">${r.delta != null ? r.delta : '—'}</span></div>
              </div>
            </div>`).join("")}
        </div>
        <p class="dk-note">
          Consensus busts from FantasyPros HOF experts. "vs ADP" shows how many spots later
          they're ranked than where they're being drafted — big red negative = getting drafted way too early.
        </p>`;

      bustsEl.querySelectorAll(".dk-sub-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          bustActivePos = btn.dataset.pos;
          paintBusts();
        });
      });
    };
    paintBusts();

    // ========== RB HANDCUFFS (CSV-driven) ==========
    const paintHandcuffs = async () => {
      const result = await getFpHandcuffs();
      if (!result.hasData) {
        handcuffsEl.innerHTML = empty("No handcuffs CSV uploaded yet. Add handcuffs.csv to assets/data/fp-csv/.");
        return;
      }
      handcuffsEl.innerHTML = `
        <div class="dk-handcuff-list">
          ${result.rows.map(p => `
            <div class="dk-handcuff-pair">
              <div class="dk-card dk-handcuff-starter">
                <div class="dk-rank">${p.starter_ecr ?? '—'}</div>
                <div class="dk-info">
                  <div class="dk-name">${esc(p.starter_name)}</div>
                  <div class="dk-meta">
                    <span class="${_pillClass('RB')}">RB</span>
                    <span class="dk-team">${esc(p.team)}</span>
                  </div>
                </div>
                <div class="dk-hc-role">Starter</div>
              </div>
              <div class="dk-handcuff-arrow">→</div>
              <div class="dk-card dk-handcuff-backup">
                <div class="dk-rank">${p.handcuff_ecr ?? '—'}</div>
                <div class="dk-info">
                  <div class="dk-name">${esc(p.handcuff_name)}</div>
                  <div class="dk-meta">
                    <span class="${_pillClass('RB')}">RB</span>
                    <span class="dk-team">${esc(p.team)}</span>
                    ${p.handcuff_adp_text ? `<span class="dk-fp">${esc(p.handcuff_adp_text)}</span>` : ''}
                  </div>
                </div>
                <div class="dk-hc-role">Handcuff</div>
              </div>
            </div>`).join("")}
        </div>
        <p class="dk-note">
          All 32 teams — projected starter paired with their handcuff. ADP shows the draft round
          where the handcuff typically goes.
        </p>`;
    };
    paintHandcuffs();

    // ========== VALUE PICKS (kept from before) ==========
    const withAdp = (dk.rankings.overall || [])
      .map(r => ({ ...r, _adp: toNum(r.adp), _rank: toNum(r.rank) }))
      .filter(r => r._adp != null && r._rank != null);
    const valuePicks = withAdp
      .map(r => ({ ...r, value: Math.round(r._adp) - r._rank }))
      .filter(r => r.value >= 5)
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);

    if (valuePicks.length) {
      adpEl.innerHTML = `
        <div class="dk-cards">
          ${valuePicks.map(r => `
            <div class="dk-card dk-value">
              <div class="dk-rank">${r.rank}</div>
              <div class="dk-info">
                <div class="dk-name">${esc(r.name)}</div>
                <div class="dk-meta">
                  <span class="${_pillClass(r.pos)}">${esc(r.pos)}</span>
                  <span class="dk-team">${esc(r.team)}</span>
                  ${r.bye ? `<span class="dk-bye">BYE ${esc(r.bye)}</span>` : ''}
                  <span class="dk-fp">ADP ${toFix(r.adp)} <span class="rank-delta up">+${r.value}</span></span>
                </div>
              </div>
              <div class="dk-stats">
                <div class="dk-stat"><span class="lbl">Proj</span><span class="val proj">${r.proj_pts != null ? Math.round(toNum(r.proj_pts)) : '—'}</span></div>
                <div class="dk-stat"><span class="lbl">Tier</span><span class="val">${r.tier ?? '—'}</span></div>
                <div class="dk-stat"><span class="lbl">Owned</span><span class="val">${r.owned_avg != null ? Math.round(toNum(r.owned_avg)) + '%' : '—'}</span></div>
              </div>
            </div>`).join("")}
        </div>
        <p class="dk-note">
          Drafted later than they're ranked. Green +N shows how many spots later they go on average.
        </p>`;
    } else {
      adpEl.innerHTML = empty("No significant value picks right now.");
    }

  } catch (e) {
    if (boardEl) boardEl.innerHTML = errBox(e.message);
  }
}

window.Pages = {
  renderHome, renderMatchups, renderStandings, renderNews,
  renderTransactions, renderHistory,
  renderWire, renderTrending, renderInsiders,
  renderInjuries, renderInjuriesWidget,
  renderDraftKit,
};

})();
