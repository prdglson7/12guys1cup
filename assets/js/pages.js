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

/* ---------- DISCORD WIDGET ---------- */
function renderDiscordWidget(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const serverId = window.Config && window.Config.DISCORD_SERVER_ID;
  const invite = window.Config && window.Config.DISCORD_INVITE_URL;

  if (!serverId) {
    el.innerHTML = `
      <div class="discord-setup">
        <div class="discord-setup-title">Discord not configured yet</div>
        <div class="discord-setup-body">
          Set <code>DISCORD_SERVER_ID</code> in <code>assets/js/config.js</code> to show the live widget.
        </div>
      </div>`;
    return;
  }

  const inviteBtn = invite
    ? `<a class="discord-invite-btn" href="${esc(invite)}" target="_blank" rel="noopener">Join the server</a>`
    : '';

  el.innerHTML = `
    <div class="discord-widget-shell">
      <iframe
        src="https://discord.com/widget?id=${esc(serverId)}&theme=dark"
        width="100%" height="400"
        allowtransparency="true" frameborder="0"
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
        title="12guys1cup Discord widget">
      </iframe>
      ${inviteBtn}
    </div>`;
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
  const weeklyEl = document.getElementById("standings-weekly");
  const seasonEl = document.getElementById("standings-season");
  stEl.innerHTML = loading();
  prEl.innerHTML = loading("Computing power rankings…");
  if (weeklyEl) weeklyEl.innerHTML = loading();
  if (seasonEl) seasonEl.innerHTML = loading();

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

    // ========== WEEKLY WINNERS/LOSERS + SEASON LEADERS (moved from Dues) ==========
    if (weeklyEl && seasonEl) {
      // Load penalty amount from dues.json
      let wp = 10;
      try {
        const res = await fetch("assets/data/dues.json", { cache: "no-cache" });
        if (res.ok) {
          const dues = await res.json();
          wp = dues.weekly_penalty || 10;
        }
      } catch (_) {}

      // Fetch matchups for all completed weeks
      const allWeeks = new Map();
      const currentWeek = (state && state.week) || 0;
      for (let w = 1; w <= 17; w++) {
        if (currentWeek > 0 && w > currentWeek) break;
        try {
          const m = await getMatchups(w);
          if (!m || !m.length) continue;
          const hasScoring = m.some(x => (x.points || 0) > 0.1);
          if (!hasScoring) continue;
          allWeeks.set(w, m);
        } catch (_) { break; }
      }

      // Weekly winners/losers table
      if (!allWeeks.size) {
        weeklyEl.innerHTML = empty("Weekly winners populate as games play.");
      } else {
        const weeklyRows = [];
        let totalPenalty = 0;
        for (const [w, matchups] of allWeeks) {
          const scored = matchups.filter(x => (x.points || 0) > 0.1);
          if (!scored.length) continue;
          const high = scored.reduce((max, x) => x.points > max.points ? x : max, scored[0]);
          const low  = scored.reduce((min, x) => x.points < min.points ? x : min, scored[0]);
          weeklyRows.push({
            week: w,
            high: { team: teams.get(high.roster_id), points: high.points },
            low:  { team: teams.get(low.roster_id),  points: low.points },
          });
          totalPenalty += wp;
        }
        weeklyEl.innerHTML = `
          <div class="dues-summary">
            Penalty pot so far: <strong class="gold">$${totalPenalty}</strong>
            across ${weeklyRows.length} week${weeklyRows.length !== 1 ? 's' : ''}
          </div>
          <table class="stats-table dues-weekly-table">
            <thead>
              <tr>
                <th>Week</th>
                <th>High score</th>
                <th class="num">Pts</th>
                <th>Low score</th>
                <th class="num">Pts</th>
                <th class="num">Owes</th>
              </tr>
            </thead>
            <tbody>
              ${weeklyRows.map(r => `
                <tr>
                  <td class="dues-week">W${r.week}</td>
                  <td class="team-cell">
                    <img class="avatar-sm" src="${esc(avatarUrl(r.high.team))}" alt="" onerror="this.src='assets/img/logo.jpg'">
                    ${esc(r.high.team?.team_name || '?')}
                  </td>
                  <td class="num gold">${fmt1(r.high.points)}</td>
                  <td class="team-cell">
                    <img class="avatar-sm" src="${esc(avatarUrl(r.low.team))}" alt="" onerror="this.src='assets/img/logo.jpg'">
                    ${esc(r.low.team?.team_name || '?')}
                  </td>
                  <td class="num red">${fmt1(r.low.points)}</td>
                  <td class="num">$${wp}</td>
                </tr>`).join('')}
            </tbody>
          </table>`;
      }

      // Season leaders
      if (!allWeeks.size) {
        seasonEl.innerHTML = empty("Season leaderboard populates as games play.");
      } else {
        const totals = new Map();
        const bestGame = { pts: 0, team: null, week: null };
        const worstGame = { pts: Infinity, team: null, week: null };
        for (const [w, matchups] of allWeeks) {
          matchups.forEach(x => {
            if (!x.roster_id) return;
            const pts = x.points || 0;
            totals.set(x.roster_id, (totals.get(x.roster_id) || 0) + pts);
            if (pts > bestGame.pts) {
              bestGame.pts = pts; bestGame.team = teams.get(x.roster_id); bestGame.week = w;
            }
            if (pts > 0 && pts < worstGame.pts) {
              worstGame.pts = pts; worstGame.team = teams.get(x.roster_id); worstGame.week = w;
            }
          });
        }
        const penaltyPot = allWeeks.size * wp;
        const ranked = Array.from(totals.entries())
          .map(([rid, pts]) => ({ roster_id: rid, team: teams.get(rid), points: pts }))
          .sort((a, b) => b.points - a.points);
        const leader = ranked[0];
        seasonEl.innerHTML = `
          <div class="dues-summary">
            🏆 <strong>${esc(leader.team?.team_name || '?')}</strong> leading the season points chase —
            on track for the <span class="gold">$${penaltyPot}</span> penalty pot at year end
          </div>
          <table class="stats-table dues-season-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th class="num">Total Points</th>
              </tr>
            </thead>
            <tbody>
              ${ranked.map((t, i) => `
                <tr class="${i === 0 ? 'top-row' : ''}">
                  <td class="rank ${i===0?'gold':''}">${i + 1}</td>
                  <td class="team-cell">
                    <img class="avatar-sm" src="${esc(avatarUrl(t.team))}" alt="" onerror="this.src='assets/img/logo.jpg'">
                    ${esc(t.team?.team_name || '?')}
                  </td>
                  <td class="num">${fmt1(t.points)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <div class="dues-records">
            <div class="dues-record">
              <div class="dues-record-label">🎯 Best single-week</div>
              <div class="dues-record-value">
                ${esc(bestGame.team?.team_name || '—')} —
                <span class="gold">${fmt1(bestGame.pts)}</span> pts, Week ${bestGame.week ?? '—'}
              </div>
            </div>
            <div class="dues-record">
              <div class="dues-record-label">💀 Worst single-week</div>
              <div class="dues-record-value">
                ${esc(worstGame.team?.team_name || '—')} —
                <span class="red">${worstGame.pts === Infinity ? '—' : fmt1(worstGame.pts)}</span> pts,
                Week ${worstGame.week ?? '—'}
              </div>
            </div>
          </div>`;
      }
    }
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

/* Load FFBallers tier + ADP overrides from tiers-adp.json.
   These take precedence over FP's tier (always null) and ADP data. */
/* Load FFBallers ADP data from tiers-adp.json */
async function loadTiersAdp() {
  try {
    const res = await fetch('assets/data/tiers-adp.json', { cache: 'default' });
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map();
    for (const [key, val] of Object.entries(data)) map.set(key, val);
    return map;
  } catch (_) { return new Map(); }
}

async function renderDraftKit() {
  const rankingsEl = document.getElementById("dk-rankings");
  const controlsEl = document.getElementById("dk-controls");
  const metaEl     = document.getElementById("dk-meta");
  if (rankingsEl) rankingsEl.innerHTML = loading("Loading Draft Kit…");

  try {
    const [dk, tiersAdp] = await Promise.all([getDraftKit(), loadTiersAdp()]);
    if (!dk?.rankings?.overall) throw new Error("Draft Kit data not loaded.");

    const overall = dk.rankings.overall;
    const baselines = computeBaselines(dk.rankings);

    // Enrich with VBD + FFBallers ADP
    const withVbd = overall.filter(p => p.name && p.pos).map(p => {
      const proj = Number(p.proj_pts) || 0;
      const base = baselines[p.pos] || 0;
      const key = (p.name || '').toLowerCase().trim();
      const ov = tiersAdp.get(key);
      return { ...p, _vbd: proj > 0 ? proj - base : -9999, _proj: proj, _adp: ov?.adp || p.adp || null };
    });

    // Positional lists sorted by projected points (not VBD)
    const byPos = {};
    ['QB','RB','WR','TE','K','DST'].forEach(pos => {
      byPos[pos] = [...withVbd].filter(p => p.pos === pos).sort((a, b) => b._proj - a._proj);
    });

    // Top 200 excluding K/DST
    const top200 = [...withVbd].filter(p => !['K','DST'].includes(p.pos)).sort((a, b) => b._vbd - a._vbd).slice(0, 200);

    const fetched = dk.fetched_at ? new Date(dk.fetched_at) : null;
    if (metaEl) {
      metaEl.textContent = `${withVbd.length} players • Full PPR • 1QB/2RB/2WR/1TE/1FLEX • updated ${fetched ? relTime(fetched.toISOString()) : 'recently'}`;
    }

    const posColors = { QB:'cs-qb', RB:'cs-rb', WR:'cs-wr', TE:'cs-te', K:'cs-k', DST:'cs-dst' };
    const posLabels = { QB:'Quarterbacks', RB:'Running Backs', WR:'Wide Receivers', TE:'Tight Ends', K:'Kickers', DST:'Defenses' };
    const posHex    = { QB:'#B8386B', RB:'#2E7D32', WR:'#1565C0', TE:'#E65100', K:'#5E35B1', DST:'#455A64' };

    const fmtAdp = (adp) => {
      if (adp == null || adp === '' || adp === '—') return '—';
      const s = String(adp).trim();
      if (s === '-' || s === 'None') return '—';
      if (s.includes('.') && s.length <= 5) return s;
      const n = Number(s);
      if (isNaN(n) || n <= 0) return s || '—';
      const round = Math.ceil(n / 12);
      const pick = ((n - 1) % 12) + 1;
      return `${round}.${String(pick).padStart(2, '0')}`;
    };

    // ===== Positional column builder =====
    const buildPosColumn = (pos) => {
      const players = byPos[pos] || [];
      return `
        <div class="cs-col">
          <div class="cs-pos-header ${posColors[pos]}">${posLabels[pos]}</div>
          <div class="cs-subheader"><span>#</span><span>Player</span><span>Bye</span><span>ADP</span></div>
          ${players.map((p, i) => `
            <div class="cs-player">
              <span class="cs-rank">${i + 1}</span>
              <span class="cs-name">${esc(p.name)} <span class="cs-team">${esc(p.team || '')}</span></span>
              <span class="cs-bye">${p.bye || '—'}</span>
              <span class="cs-adp">${fmtAdp(p._adp)}</span>
            </div>`).join('')}
        </div>`;
    };

    // ===== Top 200 builder =====
    const buildTop200 = () => {
      return [[0,50,'1 – 50'],[50,100,'51 – 100'],[100,150,'101 – 150'],[150,200,'151 – 200']].map(([s,e,label]) => {
        const slice = top200.slice(s, e);
        return `
          <div class="cs-200-col">
            <div class="cs-200-col-header">${label}</div>
            ${slice.map((p, i) => `
              <div class="cs-200-row">
                <span class="cs-200-rank">${s + i + 1}</span>
                <span class="cs-200-name">${esc(p.name)} <span class="cs-team">${esc(p.team || '')}</span></span>
                <span class="cs-200-pos ${posColors[p.pos]}">${esc(p.pos)}</span>
                <span class="cs-200-bye">${p.bye || '—'}</span>
                <span class="cs-200-adp">${fmtAdp(p._adp)}</span>
              </div>`).join('')}
          </div>`;
      }).join('');
    };

    /* Download styled .xls matching the site's look + FFBallers side-by-side layout.
       Excel reads HTML tables natively — colors, bold, layout all preserved. */
    const downloadCsv = (view) => {
      const now = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const navy='#1E3A5F',gld='#E8B84A',crm='#FDF6E3',brn='#8B5A3C';
      const phx={QB:'#B8386B',RB:'#2E7D32',WR:'#1565C0',TE:'#E65100',K:'#5E35B1',DST:'#455A64'};

      let h=`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"><style>
body{font-family:Calibri,Arial,sans-serif;margin:0}
.ttl{background:${navy};color:${gld};font-size:18px;font-weight:700;padding:10px 16px;letter-spacing:2px}
.sub{background:${navy};color:${crm};font-size:11px;padding:0 16px 8px}
.ftr{background:${navy};color:${crm};font-size:9px;padding:6px 16px}
table{border-collapse:collapse;width:100%;background:${crm}}
td{padding:2px 6px;font-size:11px;border-bottom:1px solid #E5D5A8;vertical-align:middle}
.ph{color:#fff;font-weight:700;font-size:13px;text-align:center;padding:6px;letter-spacing:2px}
.ch{background:rgba(30,58,95,0.1);font-weight:700;font-size:9px;color:${brn};text-transform:uppercase;padding:3px 6px;border-bottom:2px solid ${navy}}
.tr{background:${navy};color:${gld};font-weight:700;font-size:10px;text-align:center;padding:4px;letter-spacing:2px}
.rk{font-weight:700;color:${navy};text-align:center;width:24px}
.nm{font-weight:700;color:${navy};white-space:nowrap}
.tm{font-weight:400;color:${brn};font-size:9px}
.by{text-align:center;color:${brn};width:30px}
.ap{text-align:center;font-weight:700;color:${navy};width:36px}
.g{width:8px;background:#fff;border:none}
.pq{background:#B8386B;color:#fff;font-weight:700;font-size:9px;text-align:center;padding:1px 4px}
.pr{background:#2E7D32;color:#fff;font-weight:700;font-size:9px;text-align:center;padding:1px 4px}
.pw{background:#1565C0;color:#fff;font-weight:700;font-size:9px;text-align:center;padding:1px 4px}
.pt{background:#E65100;color:#fff;font-weight:700;font-size:9px;text-align:center;padding:1px 4px}
tr:nth-child(even) td{background:rgba(30,58,95,0.03)}
</style></head><body>`;

      if(view==='positional'){
        const poss=['QB','RB','WR','TE'];
        const ls=poss.map(p=>byPos[p]||[]);
        const mx=Math.max(...ls.map(l=>l.length));

        // Get tiers from tiersAdp
        const tByP={};
        poss.forEach(pos=>{tByP[pos]=[];(byPos[pos]||[]).forEach(p=>{
          const ov=tiersAdp.get((p.name||'').toLowerCase().trim());
          tByP[pos].push(ov?.tier||null);
        });});

        h+=`<div class="ttl">DRAFT CHEAT SHEET</div>`;
        h+=`<div class="sub">12 GUYS 1 CUP \u00b7 Full PPR \u00b7 1QB/2RB/2WR/1TE/1FLEX \u00b7 ${now}</div>`;
        h+=`<table>`;

        // Position headers
        h+=`<tr>`;
        poss.forEach((pos,pi)=>{
          if(pi>0) h+=`<td class="g"></td>`;
          h+=`<td colspan="4" class="ph" style="background:${phx[pos]}">${posLabels[pos]}</td>`;
        });
        h+=`</tr><tr>`;
        poss.forEach((pos,pi)=>{
          if(pi>0) h+=`<td class="g"></td>`;
          h+=`<td class="ch">#</td><td class="ch">Player</td><td class="ch" style="text-align:center">Bye</td><td class="ch" style="text-align:center">ADP</td>`;
        });
        h+=`</tr>`;

        // Rows with tier breaks
        const tt=poss.map(()=>null);
        for(let i=0;i<mx;i++){
          let needT=false;
          poss.forEach((pos,pi)=>{const t=tByP[pos][i];if(t&&t!==tt[pi])needT=true;});
          if(needT){
            h+=`<tr>`;
            poss.forEach((pos,pi)=>{
              if(pi>0) h+=`<td class="g"></td>`;
              const t=tByP[pos][i];
              if(t&&t!==tt[pi]){tt[pi]=t;h+=`<td colspan="4" class="tr">TIER ${t}</td>`;}
              else h+=`<td colspan="4" style="border:none"></td>`;
            });
            h+=`</tr>`;
          }
          h+=`<tr>`;
          poss.forEach((pos,pi)=>{
            if(pi>0) h+=`<td class="g"></td>`;
            const p=ls[pi][i];
            if(p) h+=`<td class="rk">${i+1}</td><td class="nm">${esc(p.name)} <span class="tm">${esc(p.team||'')}</span></td><td class="by">${p.bye||'\u2014'}</td><td class="ap">${fmtAdp(p._adp)}</td>`;
            else h+=`<td colspan="4"></td>`;
          });
          h+=`</tr>`;
        }
        h+=`</table>`;
        h+=`<div class="ftr">12guys1cup.com \u00b7 Full PPR \u00b7 12 Teams \u00b7 Updated ${now}</div>`;
      } else {
        h+=`<div class="ttl">TOP 200 OVERALL</div>`;
        h+=`<div class="sub">12 GUYS 1 CUP \u00b7 Excludes K & DST \u00b7 ${now}</div>`;
        h+=`<table><tr><td class="ch">#</td><td class="ch">Player</td><td class="ch">Pos</td><td class="ch" style="text-align:center">Bye</td><td class="ch" style="text-align:center">ADP</td></tr>`;
        top200.forEach((p,i)=>{
          const pc=(p.pos||'').toLowerCase();
          h+=`<tr><td class="rk">${i+1}</td><td class="nm">${esc(p.name)} <span class="tm">${esc(p.team||'')}</span></td><td class="p${pc[0]||'r'}">${esc(p.pos)}</td><td class="by">${p.bye||'\u2014'}</td><td class="ap">${fmtAdp(p._adp)}</td></tr>`;
        });
        h+=`</table>`;
        h+=`<div class="ftr">12guys1cup.com \u00b7 Top 200 \u00b7 Updated ${now}</div>`;
      }
      h+=`</body></html>`;
      const blob=new Blob([h],{type:'application/vnd.ms-excel'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download=view==='positional'?'12guys1cup-cheat-sheet.xls':'12guys1cup-top-200.xls';
      a.click();
      URL.revokeObjectURL(url);
    };

    // ===== TABS + RENDER =====
    const views = ['Cheat Sheet', 'Top 200', 'K', 'DST'];
    let activeView = 'Cheat Sheet';

    const paintRankings = () => {
      controlsEl.innerHTML = `
        <div class="dk-tabs">
          ${views.map(v => `<button class="dk-tab ${v === activeView ? 'active' : ''}" data-view="${v}"><span class="dk-tab-label">${v}</span></button>`).join("")}
        </div>
        <div class="dk-controls-row">
          <button class="dk-csv-btn" id="dk-csv-download">Download</button>
        </div>`;

      if (activeView === 'Cheat Sheet') {
        rankingsEl.innerHTML = `
          <div class="cs-sheet">
            <div class="cs-header">
              <div class="cs-header-left"><div class="cs-title">Draft Cheat Sheet</div><div class="cs-subtitle">Positional Rankings</div></div>
              <div class="cs-header-right"><div class="cs-league">12 GUYS 1 CUP</div>Full PPR · 1QB/2RB/2WR/1TE/1FLEX<br>Draft Day: Sept 6, 2026</div>
            </div>
            <div class="cs-grid">${buildPosColumn('QB')}${buildPosColumn('RB')}${buildPosColumn('WR')}${buildPosColumn('TE')}</div>
            <div class="cs-footer"><span>12guys1cup.com</span><span>Full PPR · 1QB/2RB/2WR/1TE/1FLEX(RB/WR/TE) · 12 Teams</span><span>Updated ${fetched ? fetched.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'recently'}</span></div>
          </div>`;
      } else if (activeView === 'Top 200') {
        rankingsEl.innerHTML = `
          <div class="cs-sheet">
            <div class="cs-header">
              <div class="cs-header-left"><div class="cs-title">Top 200 Overall</div><div class="cs-subtitle">Excludes K &amp; DST</div></div>
              <div class="cs-header-right"><div class="cs-league">12 GUYS 1 CUP</div>Full PPR · 1QB/2RB/2WR/1TE/1FLEX</div>
            </div>
            <div class="cs-200-grid">${buildTop200()}</div>
            <div class="cs-footer"><span>12guys1cup.com</span><span>Top 200 Overall · Excludes K &amp; DST</span><span>Updated ${fetched ? fetched.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'recently'}</span></div>
          </div>`;
      } else {
        const pos = activeView;
        const players = byPos[pos] || [];
        rankingsEl.innerHTML = `
          <div class="cs-sheet">
            <div class="cs-header">
              <div class="cs-header-left"><div class="cs-title">${posLabels[pos]} Rankings</div><div class="cs-subtitle">12 GUYS 1 CUP</div></div>
              <div class="cs-header-right"><div class="cs-league">12 GUYS 1 CUP</div></div>
            </div>
            <div class="cs-single-col">
              <div class="cs-subheader cs-subheader-wide"><span>#</span><span>Player</span><span>Bye</span><span>Proj</span><span>ADP</span></div>
              ${players.map((p, i) => `
                <div class="cs-player cs-player-wide">
                  <span class="cs-rank">${i + 1}</span>
                  <span class="cs-name">${esc(p.name)} <span class="cs-team">${esc(p.team || '')}</span></span>
                  <span class="cs-bye">${p.bye || '—'}</span>
                  <span class="cs-adp">${p._proj ? p._proj.toFixed(0) : '—'}</span>
                  <span class="cs-adp">${fmtAdp(p._adp)}</span>
                </div>`).join('')}
            </div>
            <div class="cs-footer"><span>12guys1cup.com</span><span>${posLabels[pos]}</span><span>Updated ${fetched ? fetched.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'recently'}</span></div>
          </div>`;
      }

      controlsEl.querySelectorAll('.dk-tab').forEach(btn => {
        btn.addEventListener('click', () => { activeView = btn.dataset.view; paintRankings(); });
      });

      document.getElementById('dk-csv-download')?.addEventListener('click', () => {
        if (activeView === 'Cheat Sheet') downloadCsv('positional');
        else if (activeView === 'Top 200') downloadCsv('top200');
        else {
          const players = byPos[activeView] || [];
          const rows = ['Rank,Player,Pos,Team,Bye,Proj,ADP'];
          players.forEach((r,i) => rows.push([i+1,'"'+(r.name||'').replace(/"/g,'""')+'"',r.pos||'',r.team||'',r.bye||'',r._proj?r._proj.toFixed(1):'',r._adp||''].join(',')));
          const blob = new Blob([rows.join('\n')],{type:'text/csv'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href=url; a.download=`12guys1cup-${activeView.toLowerCase()}-rankings.csv`; a.click();
          URL.revokeObjectURL(url);
        }
      });
    };

    paintRankings();
  } catch (e) {
    if (rankingsEl) rankingsEl.innerHTML = errBox(e.message);
  }
}



/* ---------- DUES ---------- */
async function renderDues() {
  const paymentsEl = document.getElementById("dues-payments");
  const metaEl = document.getElementById("dues-meta");

  paymentsEl.innerHTML = loading("Loading dues…");

  try {
    const { teams } = await bootstrap();

    // Load dues config (paid teams tracker)
    let dues = { paid_roster_ids: [], dues_amount: 150, weekly_penalty: 10 };
    try {
      const res = await fetch("assets/data/dues.json", { cache: "no-cache" });
      if (res.ok) dues = await res.json();
    } catch (_) {}
    const paidIds = new Set((dues.paid_roster_ids || []).map(Number));
    const amt = dues.dues_amount || 150;

    // ========== PAYMENT STATUS ==========
    const teamList = Array.from(teams.values());
    const paidCount = teamList.filter(t => paidIds.has(t.roster_id)).length;
    const collected = paidCount * amt;
    const target = teamList.length * amt;

    metaEl.textContent = `$${amt} per team • ${paidCount}/${teamList.length} paid • $${collected} of $${target} collected`;

    // Sort: paid first, then owing (both alphabetical)
    const sortedTeams = [...teamList].sort((a, b) => {
      const aP = paidIds.has(a.roster_id) ? 0 : 1;
      const bP = paidIds.has(b.roster_id) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return (a.team_name || '').localeCompare(b.team_name || '');
    });

    paymentsEl.innerHTML = `
      <table class="stats-table dues-table">
        <thead>
          <tr>
            <th>Team</th>
            <th class="num">ID</th>
            <th class="num">Status</th>
          </tr>
        </thead>
        <tbody>
          ${sortedTeams.map(t => {
            const paid = paidIds.has(t.roster_id);
            return `
              <tr class="${paid ? 'dues-row-paid' : 'dues-row-owing'}">
                <td>
                  <div class="team-cell">
                    <img class="avatar-sm" src="${esc(avatarUrl(t))}" alt="" onerror="this.src='assets/img/logo.jpg'">
                    ${esc(t.team_name)}
                  </div>
                </td>
                <td class="num">${t.roster_id}</td>
                <td class="num">
                  ${paid
                    ? '<span class="dues-badge dues-paid">✓ Paid</span>'
                    : '<span class="dues-badge dues-owing">✗ Owing</span>'}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    paymentsEl.innerHTML = errBox(e.message);
  }
}


/* ============================================================
   TOOLS — Trade Analyzer + Start/Sit
   Statistically unbiased algorithm using Value Based Drafting (VBD)
   Phase 2 additions: xFP regression, snap trends, playoff SoS
   ============================================================ */

/* ---------- nflverse data loader (Phase 1 pipeline output) ---------- */

async function loadNflverseData() {
  const files = ['xfp', 'snap-counts', 'def-vs-pos', 'schedules', 'weekly-stats'];
  const results = {};
  await Promise.all(files.map(async (f) => {
    try {
      const res = await fetch(`assets/data/nflverse/${f}.json`, { cache: 'default' });
      results[f] = res.ok ? await res.json() : null;
    } catch (_) {
      results[f] = null;
    }
  }));

  // Build fast lookup maps by normalized name
  const xfpByName = new Map();
  if (results['xfp']?.players) {
    for (const p of Object.values(results['xfp'].players)) {
      if (p.name) xfpByName.set(normalizeName(p.name), p);
    }
  }

  const snapByName = new Map();
  if (results['snap-counts']?.players) {
    for (const p of Object.values(results['snap-counts'].players)) {
      if (p.name) snapByName.set(normalizeName(p.name), p);
    }
  }

  // Also build a target-share / usage index from weekly-stats (WR/TE/RB usage signal)
  const usageByName = new Map();
  if (results['weekly-stats']?.players) {
    for (const p of Object.values(results['weekly-stats'].players)) {
      if (!p.name || !p.weeks?.length) continue;
      // Recent 3 weeks vs season avg target share
      const withShare = p.weeks.filter(w => w.tgt_share != null);
      if (withShare.length >= 3) {
        const recent = withShare.slice(-3);
        const recentAvg = recent.reduce((s, w) => s + (w.tgt_share || 0), 0) / recent.length;
        const seasonAvg = withShare.reduce((s, w) => s + (w.tgt_share || 0), 0) / withShare.length;
        usageByName.set(normalizeName(p.name), {
          recent_tgt_share: recentAvg,
          season_tgt_share: seasonAvg,
          tgt_share_delta: recentAvg - seasonAvg,
        });
      }
    }
  }

  // Season used for game context lookup: prefer current, fall back to prior
  const gameCtx = results['schedules']?.game_context || {};
  const availableSeasons = Object.keys(gameCtx);
  const contextSeason = availableSeasons.length
    ? availableSeasons.sort().slice(-1)[0]
    : null;

  return {
    xfp: xfpByName,
    snaps: snapByName,
    usage: usageByName,
    defVsPos: results['def-vs-pos']?.defenses || {},
    playoffOpps: results['schedules']?.playoff_opponents || {},
    gameContext: contextSeason ? gameCtx[contextSeason] : {},
    contextSeason,
    available: (xfpByName.size > 0 || snapByName.size > 0),
    xfpSeason: results['xfp']?.season,
    snapSeason: results['snap-counts']?.season,
    defSeason: results['def-vs-pos']?.season,
  };
}

/* Enrich an FP player with nflverse signals for value adjustments. */
function enrichPlayer(player, nflverse) {
  if (!nflverse) return;
  const key = normalizeName(player.name);

  // xFP regression signal
  const xfp = nflverse.xfp.get(key);
  if (xfp && (xfp.total_xfp || 0) > 30 && (xfp.total_actual || 0) > 30) {
    player._xfp_gap = xfp.gap;
    player._xfp_total = xfp.total_xfp;
    player._actual_total = xfp.total_actual;
  }

  // Snap trend — average delta of last 3 weeks with data
  const snaps = nflverse.snaps.get(key);
  if (snaps?.weeks?.length) {
    const withPct = snaps.weeks.filter(w => w.off_pct != null);
    if (withPct.length >= 1) {
      // Latest week snapshot (used by Waiver Wire snap risers)
      const latest = withPct[withPct.length - 1];
      player._latest_snap_pct = latest.off_pct;
      player._latest_snap_delta = latest.off_pct_delta;
      player._latest_snap_week = latest.week;
    }
    if (withPct.length >= 3) {
      const recent = withPct.slice(-3);
      const older = withPct.slice(0, -3);
      if (older.length) {
        const recentAvg = recent.reduce((s, w) => s + (w.off_pct || 0), 0) / recent.length;
        const olderAvg = older.reduce((s, w) => s + (w.off_pct || 0), 0) / older.length;
        player._snap_trend = recentAvg - olderAvg;
        player._snap_recent = recentAvg;
      }
    }
  }

  // Playoff SoS — average opponent DEF vs POS rank in weeks 15-17
  if (player.team && nflverse.playoffOpps[player.team]) {
    const opps = nflverse.playoffOpps[player.team].filter(Boolean);
    const ranks = opps
      .map(opp => nflverse.defVsPos[opp]?.[player.pos]?.rank)
      .filter(r => r != null);
    if (ranks.length) {
      player._playoff_avg_rank = ranks.reduce((s, r) => s + r, 0) / ranks.length;
      player._playoff_opps = opps;
    }
  }

  // Target share (WR/TE/RB) from weekly-stats
  const usage = nflverse.usage.get(key);
  if (usage) {
    player._recent_tgt_share = usage.recent_tgt_share;
    player._season_tgt_share = usage.season_tgt_share;
    player._tgt_share_delta = usage.tgt_share_delta;
  }
}

/* Baseline ranks for 12-team full PPR (1QB/2RB/2WR/1TE/1FLEX/1K/1DEF)
   = the last "startable" player at each position.
   FLEX (RB/WR/TE) splits ~60% RB / 35% WR / 5% TE historically. */
const VBD_BASELINE_RANKS = {
  QB:  12,   // 12 teams × 1 QB
  RB:  30,   // 12×2 = 24 fixed + ~6 FLEX RBs
  WR:  28,   // 12×2 = 24 fixed + ~4 FLEX WRs
  TE:  13,   // 12×1 = 12 fixed + ~1 FLEX TE
  K:   12,
  DST: 12,
};

/* Custom baseline overrides — uncomment any position to override
   the auto-computed value from actual projections.
const CUSTOM_BASELINES = {
  // RB: 175.0,
  // WR: 196.6,
  // TE: 157.5,
};
*/
const CUSTOM_BASELINES = {};

/* Fallback injury discount used only if FP hasn't published a play probability. */
const INJURY_STATUS_FALLBACK = {
  'Out': 0.05, 'IR': 0.05, 'PUP': 0.10, 'Sus': 0.05,
  'Doubtful': 0.35,
  'Questionable': 0.80,
  'Probable': 0.95,
};

function normalizeName(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .trim();
}

/** Compute VBD baseline projections from actual ranked players.
    Reads from rankings.overall filtered by position (per-position
    arrays aren't produced by fetch-draftkit.js).
    If we don't have enough projected players to hit the target rank,
    fall back to the LAST player with a projection so we still get a
    meaningful baseline. */
function computeBaselines(rankings) {
  const baselines = {};
  const overall = rankings?.overall || [];
  Object.entries(VBD_BASELINE_RANKS).forEach(([pos, rank]) => {
    // Custom override wins if provided
    if (CUSTOM_BASELINES[pos] != null) {
      baselines[pos] = CUSTOM_BASELINES[pos];
      return;
    }
    const positional = overall
      .filter(p => p.pos === pos)
      .map(p => Number(p.proj_pts))
      .filter(n => n != null && !isNaN(n) && n > 0)
      .sort((a, b) => b - a);
    // Prefer the requested rank, fall back to the deepest player with data
    baselines[pos] = positional[rank - 1] ?? positional[positional.length - 1] ?? 0;
  });
  return baselines;
}

/** VBD-based player value with Phase 2 enhancements:
    (Projected − Baseline) × Injury × Snap Trend × Regression × Playoff SoS */
function computePlayerValue(player, baselines) {
  const proj = Number(player.proj_pts) || 0;
  const baseline = baselines[player.pos] || 0;
  const par = proj - baseline;   // Points Above Replacement

  // Floor: below-replacement players still have minimal roster utility
  const baseValue = par > 0 ? par : Math.max(proj * 0.05, 2);

  // Injury adjustment — prefer FP's published probability, fall back to status
  let injuryMult = 1.0;
  let injuryLabel = null;
  if (player._injury_prob != null && player._injury_prob >= 0 && player._injury_prob <= 1) {
    injuryMult = player._injury_prob;
    injuryLabel = `${(player._injury_prob * 100).toFixed(0)}% play prob`;
  } else if (player._injury && INJURY_STATUS_FALLBACK[player._injury] != null) {
    injuryMult = INJURY_STATUS_FALLBACK[player._injury];
    injuryLabel = player._injury;
  }

  // === Phase 2 enhancements (from nflverse data) ===

  // 1. Snap Trend adjustment (usage signal for ROS)
  //    +20% snap trend → +10% value; -20% trend → -10% value; clamped ±15%
  let snapMult = 1.0;
  let snapLabel = null;
  if (player._snap_trend != null && Math.abs(player._snap_trend) > 0.05) {
    const adj = Math.max(-0.15, Math.min(0.15, player._snap_trend * 0.5));
    snapMult = 1.0 + adj;
    const pct = (player._snap_trend * 100).toFixed(0);
    snapLabel = player._snap_trend > 0 ? `snap ↑${pct}%` : `snap ↓${pct}%`;
  }

  // 2. Regression (xFP) adjustment
  //    Actual >> expected = lucky (discount), Actual << expected = unlucky (boost)
  //    Only kicks in when |gap| > 15 points (real signal, not noise)
  let regressionMult = 1.0;
  let regressionLabel = null;
  if (player._xfp_gap != null && Math.abs(player._xfp_gap) > 15) {
    const adj = Math.max(-0.15, Math.min(0.15, -player._xfp_gap / 200));
    regressionMult = 1.0 + adj;
    regressionLabel = player._xfp_gap > 0
      ? `+${player._xfp_gap.toFixed(0)} vs xFP (regress ↓)`
      : `${player._xfp_gap.toFixed(0)} vs xFP (regress ↑)`;
  }

  // 3. Playoff SoS adjustment
  //    Avg opponent DEF rank 1-32 in weeks 15-17.
  //    1 = toughest defense (bad matchup), 32 = softest (good matchup)
  //    Neutral = 16.5. Every rank point off neutral = 0.6% value adjustment.
  let playoffMult = 1.0;
  let playoffLabel = null;
  if (player._playoff_avg_rank != null) {
    const adj = (player._playoff_avg_rank - 16.5) / 100;  // ±0.155 max
    playoffMult = 1.0 + adj;
    playoffLabel = `playoff SoS ${player._playoff_avg_rank.toFixed(0)}/32`;
  }

  const value = baseValue * injuryMult * snapMult * regressionMult * playoffMult;

  return {
    value,
    proj, baseline, par, baseValue,
    injuryMult, injuryLabel,
    snapMult, snapLabel,
    regressionMult, regressionLabel,
    playoffMult, playoffLabel,
    hasEnhancements: !!(snapLabel || regressionLabel || playoffLabel),
  };
}

async function renderTools() {
  // Set up tab switching
  document.querySelectorAll(".tools-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tools-tab").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tools-panel").forEach(p => {
        p.classList.toggle("active", p.id === `tools-${tab}`);
      });
    });
  });

  const tradeBody = document.getElementById("trade-body");
  const ssBody = document.getElementById("startsit-body");
  const finderBody = document.getElementById("finder-body");
  const tradeMeta = document.getElementById("trade-meta");
  const ssMeta = document.getElementById("ss-meta");
  const finderMeta = document.getElementById("finder-meta");

  tradeBody.innerHTML = loading("Loading player database…");
  ssBody.innerHTML = loading("Loading player database…");
  finderBody.innerHTML = loading("Loading rosters…");

  // Load player database from draftkit.json
  const dk = await getDraftKit();
  if (!dk || !dk.rankings || !dk.rankings.overall) {
    tradeBody.innerHTML = errBox("Draft Kit data unavailable — cannot load player database.");
    ssBody.innerHTML = errBox("Draft Kit data unavailable.");
    finderBody.innerHTML = errBox("Draft Kit data unavailable.");
    return;
  }

  const allPlayers = dk.rankings.overall.filter(p => p.name && p.pos);
  console.log(`Player DB loaded: ${allPlayers.length} players`);

  // Compute VBD baselines from actual data
  const baselines = computeBaselines(dk.rankings);
  console.log('Baselines:', baselines);

  // Load injuries including probability of playing
  const injuries = await getFantasyProsInjuries();
  const injuryByName = new Map();
  (injuries.injuries || []).forEach(inj => {
    if (!inj.name) return;
    const prob = inj.probability_of_playing != null && inj.probability_of_playing !== ''
      ? parseFloat(inj.probability_of_playing)
      : null;
    injuryByName.set(normalizeName(inj.name), {
      status: inj.status || null,
      prob: (prob != null && !isNaN(prob)) ? prob : null,
    });
  });

  // Attach injury data to each player
  allPlayers.forEach(p => {
    const inj = injuryByName.get(normalizeName(p.name));
    p._injury = inj?.status || null;
    p._injury_prob = inj?.prob != null ? inj.prob : null;
  });

  // Load nflverse data + enrich each player (Phase 2)
  const nflverse = await loadNflverseData();
  if (nflverse.available) {
    allPlayers.forEach(p => enrichPlayer(p, nflverse));
    console.log(`nflverse enrichment applied — xFP: ${nflverse.xfp.size}, snaps: ${nflverse.snaps.size}, def: ${Object.keys(nflverse.defVsPos).length}`);
  } else {
    console.log('nflverse data unavailable — run Update nflverse data workflow first');
  }

  const fetched = dk.fetched_at ? new Date(dk.fetched_at) : null;
  const enhancedNote = nflverse.available ? ' • Enhanced with nflverse' : '';
  tradeMeta.textContent = `${allPlayers.length} players • VBD${enhancedNote} • ${dk.scoring || 'PPR'} • updated ${fetched ? relTime(fetched.toISOString()) : 'recently'}`;
  ssMeta.textContent = `${allPlayers.length} players • ${dk.scoring || 'PPR'} • updated ${fetched ? relTime(fetched.toISOString()) : 'recently'}`;

  // Load league rosters (best-effort — Trade Finder gracefully degrades)
  let teamsWithRosters = null;
  try {
    teamsWithRosters = await window.Sleeper.buildTeamsWithRosters();
  } catch (e) {
    console.log('Could not load rosters:', e.message);
  }

  renderTradeAnalyzer(allPlayers, baselines, tradeBody);
  renderStartSit(allPlayers, ssBody, nflverse);
  renderTradeFinder(allPlayers, baselines, teamsWithRosters, finderBody, finderMeta);
}

/* ---------- Player search dropdown (shared) ---------- */
function playerSearchHtml(id, placeholder) {
  return `
    <div class="player-search">
      <input type="search" id="${id}" placeholder="${esc(placeholder)}" autocomplete="off">
      <div id="${id}-results" class="player-search-results"></div>
    </div>`;
}

function attachPlayerSearch(inputId, allPlayers, onPick) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(`${inputId}-results`);
  if (!input) return;

  const search = (q) => {
    if (!q || q.length < 2) { results.innerHTML = ''; results.style.display = 'none'; return; }
    const qn = q.toLowerCase();
    const matches = allPlayers
      .filter(p => (p.name || '').toLowerCase().includes(qn))
      .slice(0, 8);
    if (!matches.length) {
      results.innerHTML = '<div class="player-search-empty">No matches</div>';
      results.style.display = 'block';
      return;
    }
    results.innerHTML = matches.map((p, i) => `
      <button class="player-search-item" data-idx="${allPlayers.indexOf(p)}">
        <span class="player-search-rank">#${p.rank || '—'}</span>
        <span class="player-search-name">${esc(p.name)}</span>
        <span class="${_pillClass(p.pos)}">${esc(p.pos)}</span>
        <span class="player-search-team">${esc(p.team || '')}</span>
      </button>`).join('');
    results.style.display = 'block';
    results.querySelectorAll('.player-search-item').forEach(b => {
      b.addEventListener('click', () => {
        const idx = Number(b.dataset.idx);
        onPick(allPlayers[idx]);
        input.value = '';
        results.innerHTML = '';
        results.style.display = 'none';
      });
    });
  };

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => search(input.value.trim()), 150);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) search(input.value.trim());
  });
  document.addEventListener('click', (e) => {
    if (!input.parentElement.contains(e.target)) {
      results.style.display = 'none';
    }
  });
}

/* ---------- Trade Analyzer ---------- */
function renderTradeAnalyzer(allPlayers, baselines, container) {
  let teamA = [];
  let teamB = [];

  container.innerHTML = `
    <div class="trade-grid">
      <div class="trade-side">
        <h3 class="trade-side-title">Team A gives</h3>
        ${playerSearchHtml('trade-a-search', 'Search player to add…')}
        <div id="trade-a-list" class="trade-list"></div>
        <div id="trade-a-total" class="trade-total"></div>
      </div>
      <div class="trade-vs">⇄</div>
      <div class="trade-side">
        <h3 class="trade-side-title">Team B gives</h3>
        ${playerSearchHtml('trade-b-search', 'Search player to add…')}
        <div id="trade-b-list" class="trade-list"></div>
        <div id="trade-b-total" class="trade-total"></div>
      </div>
    </div>

    <div id="trade-verdict" class="trade-verdict-empty">
      Add at least 1 player to each side to see the verdict
    </div>

    <button class="tools-toggle" id="trade-toggle-math">
      Show me the math ▼
    </button>
    <div id="trade-math" class="tools-math hidden">
      <h4>Enhanced VBD Trade Analyzer — Phase 2</h4>
      <pre class="tools-formula">Adjusted Value = Raw VORP
              × Injury Prob
              × Snap Trend
              × Regression
              × Playoff SoS
              ± Consolidation Adjustment

━━━ STEP 1: RAW VORP PER PLAYER ━━━
VORP = Projected Points − Position Baseline

━━━ POSITION BASELINE ━━━
Projected points of the LAST STARTABLE player at each position:

  Position   Baseline Rank    ${'Current baseline (pts)'}
  QB         QB12             ${(baselines.QB || 0).toFixed(1)}
  RB         RB30             ${(baselines.RB || 0).toFixed(1)}
  WR         WR36             ${(baselines.WR || 0).toFixed(1)}
  TE         TE12             ${(baselines.TE || 0).toFixed(1)}
  K          K12              ${(baselines.K || 0).toFixed(1)}
  DST        DST12            ${(baselines.DST || 0).toFixed(1)}

Computed from actual FP data every fetch — no hardcoded values.

━━━ STEP 2: INJURY PROBABILITY ━━━
FantasyPros' published probability_of_playing (0-100%).
Fallback if unpublished:
  Questionable × 0.80    Doubtful × 0.35
  Out/IR/Sus  × 0.05    Probable × 0.95

━━━ STEP 3: SNAP TREND (nflverse) ━━━
Compares each player's recent 3-week snap % to earlier season avg.
Rising usage → boost value. Declining usage → discount value.
Formula: 1.0 + (trend_delta × 0.5), clipped ±15%
Only kicks in when |delta| > 5%.

━━━ STEP 4: REGRESSION (xFP, nflverse) ━━━
Compares each player's actual season fantasy points to their
Expected Fantasy Points (from ff_opportunity data). Big gap =
they got lucky/unlucky, expect regression.

Formula: 1.0 + (-gap / 200), clipped ±15%
Only kicks in when |gap| > 15 points.

  Player scoring 20+ pts more than expected → -10% (regress ↓)
  Player scoring 20+ pts less than expected → +10% (regress ↑)

━━━ STEP 5: PLAYOFF SoS (nflverse) ━━━
Averages the player's DEF vs POS rank from their team's
opponents in weeks 15, 16, 17.
  1 = toughest matchup (bad) → -15% value
  32 = softest matchup (good) → +15% value
Neutral = rank 16.5.

━━━ STEP 6: CONSOLIDATION PENALTY ━━━
Trading 3-for-1 is NOT equal even with same raw VORP.
  Drop penalty:   +10 VORP per extra player received
  Waiver gain:    −3 VORP per freed spot

━━━ STEP 7: FAIRNESS SCORE (0-100) ━━━
Fairness = 100 − (|diff| ÷ higher_side × 100)

  95-100  PERFECTLY BALANCED
  85-95   VERY FAIR
  75-85   FAIR
  65-75   SLIGHTLY UNEVEN
  50-65   UNEVEN
  30-50   UNFAIR
   0-30   ROBBERY 🚨

━━━ NOTE ON PHASE 2 SIGNALS ━━━
The snap trend, regression, and playoff SoS multipliers only
kick in when nflverse data is available AND has meaningful
signal. Below-noise-threshold signals default to 1.0 (no
adjustment). Multipliers are visible on player cards when
active — no hidden adjustments.</pre>
    </div>`;

  const toggle = document.getElementById('trade-toggle-math');
  const math = document.getElementById('trade-math');
  toggle.addEventListener('click', () => {
    const hidden = math.classList.toggle('hidden');
    toggle.textContent = hidden ? 'Show me the math ▼' : 'Hide the math ▲';
  });

  const repaint = () => {
    ['a', 'b'].forEach(side => {
      const team = side === 'a' ? teamA : teamB;
      const listEl = document.getElementById(`trade-${side}-list`);
      const totalEl = document.getElementById(`trade-${side}-total`);
      if (!team.length) {
        listEl.innerHTML = '<div class="trade-empty">No players added yet</div>';
        totalEl.innerHTML = '';
        return;
      }
      let total = 0;
      listEl.innerHTML = team.map((p, i) => {
        const v = computePlayerValue(p, baselines);
        total += v.value;
        // Build tooltip breakdown
        const bits = [`Proj ${v.proj.toFixed(1)} − Baseline ${v.baseline.toFixed(1)} = PAR ${v.par.toFixed(1)}`];
        if (v.injuryLabel) bits.push(`× ${v.injuryMult.toFixed(2)} (${v.injuryLabel})`);
        if (v.snapLabel) bits.push(`× ${v.snapMult.toFixed(2)} (${v.snapLabel})`);
        if (v.regressionLabel) bits.push(`× ${v.regressionMult.toFixed(2)} (${v.regressionLabel})`);
        if (v.playoffLabel) bits.push(`× ${v.playoffMult.toFixed(2)} (${v.playoffLabel})`);
        const tooltip = bits.join(' ');

        // Enhancement chips shown inline
        const enhancementChips = [];
        if (v.snapLabel) enhancementChips.push(`<span class="chip chip-snap">${esc(v.snapLabel)}</span>`);
        if (v.regressionLabel) enhancementChips.push(`<span class="chip chip-regression">${esc(v.regressionLabel)}</span>`);
        if (v.playoffLabel) enhancementChips.push(`<span class="chip chip-playoff">${esc(v.playoffLabel)}</span>`);

        return `
          <div class="trade-player" title="${esc(tooltip)}">
            <div class="trade-player-info">
              <div class="trade-player-name">${esc(p.name)}
                ${v.injuryLabel ? `<span class="trade-injury">${esc(v.injuryLabel)}</span>` : ''}
              </div>
              <div class="trade-player-meta">
                <span class="${_pillClass(p.pos)}">${esc(p.pos)}</span>
                <span class="trade-team">${esc(p.team || '')}</span>
                <span class="trade-rank">ECR #${p.rank || '—'}</span>
              </div>
              ${enhancementChips.length ? `<div class="trade-player-chips">${enhancementChips.join('')}</div>` : ''}
            </div>
            <div class="trade-player-value">${v.value.toFixed(1)}</div>
            <button class="trade-remove" data-side="${side}" data-idx="${i}" aria-label="Remove">✕</button>
          </div>`;
      }).join('');
      totalEl.innerHTML = `
        <div class="trade-total-label">Raw VORP given</div>
        <div class="trade-total-value">${total.toFixed(1)}</div>`;
      listEl.querySelectorAll('.trade-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.idx);
          if (btn.dataset.side === 'a') teamA.splice(idx, 1);
          else teamB.splice(idx, 1);
          repaint();
        });
      });
    });

    // Verdict — VORP + consolidation + fairness score
    const verdictEl = document.getElementById('trade-verdict');
    if (!teamA.length || !teamB.length) {
      verdictEl.className = 'trade-verdict-empty';
      verdictEl.textContent = 'Add at least 1 player to each side to see the verdict';
      return;
    }

    // Raw VORP each side gives up
    const rawA = teamA.reduce((s, p) => s + computePlayerValue(p, baselines).value, 0);
    const rawB = teamB.reduce((s, p) => s + computePlayerValue(p, baselines).value, 0);

    // Consolidation math
    const DROP_PENALTY = 10;   // VORP of average droppable bench player
    const WAIVER_GAIN = 3;     // VORP of average waiver pickup
    const rosterDelta = teamB.length - teamA.length;  // positive if A receives more

    let adjA = rawA, adjB = rawB;
    let noteA = '', noteB = '';
    let consolidationDetail = '';

    if (rosterDelta > 0) {
      // Team A receives MORE players — must drop existing bench
      const penalty = rosterDelta * DROP_PENALTY;
      const spotGain = rosterDelta * WAIVER_GAIN;
      adjA += penalty;   // effectively gives up more (must drop rostered players)
      adjB -= spotGain;  // effectively gives up less (frees spots)
      noteA = `+${penalty.toFixed(0)} drop penalty`;
      noteB = `−${spotGain.toFixed(0)} freed spots`;
      consolidationDetail = `Team A receives ${rosterDelta} more player${rosterDelta > 1 ? 's' : ''} → must drop ${rosterDelta} rostered player${rosterDelta > 1 ? 's' : ''} (~${penalty.toFixed(0)} VORP lost). Team B frees ${rosterDelta} spot${rosterDelta > 1 ? 's' : ''} for waiver adds (~${spotGain.toFixed(0)} VORP gained).`;
    } else if (rosterDelta < 0) {
      const spots = Math.abs(rosterDelta);
      const penalty = spots * DROP_PENALTY;
      const spotGain = spots * WAIVER_GAIN;
      adjB += penalty;
      adjA -= spotGain;
      noteB = `+${penalty.toFixed(0)} drop penalty`;
      noteA = `−${spotGain.toFixed(0)} freed spots`;
      consolidationDetail = `Team B receives ${spots} more player${spots > 1 ? 's' : ''} → must drop ${spots} rostered player${spots > 1 ? 's' : ''} (~${penalty.toFixed(0)} VORP lost). Team A frees ${spots} spot${spots > 1 ? 's' : ''} for waiver adds (~${spotGain.toFixed(0)} VORP gained).`;
    }

    // Fairness score & label
    const diff = adjA - adjB;
    const higher = Math.max(adjA, adjB, 0.01);
    const pctDiff = Math.abs(diff) / higher * 100;
    const fairness = Math.max(0, Math.min(100, Math.round(100 - pctDiff)));

    let label, cls, note;
    if (fairness >= 95) {
      label = 'PERFECTLY BALANCED';
      cls = 'fair-100';
      note = 'Effectively even. Both sides get what they give.';
    } else if (fairness >= 85) {
      label = 'VERY FAIR';
      cls = 'fair-90';
      note = 'Minor edge but well within acceptable range.';
    } else if (fairness >= 75) {
      label = 'FAIR';
      cls = 'fair-80';
      note = 'One side has an edge but the other still gets reasonable value.';
    } else if (fairness >= 65) {
      label = 'SLIGHTLY UNEVEN';
      cls = 'fair-70';
      note = 'Meaningful gap. Losing side should ask for a sweetener.';
    } else if (fairness >= 50) {
      label = 'UNEVEN';
      cls = 'fair-60';
      note = 'Big gap. Losing side should decline unless they need the position badly.';
    } else if (fairness >= 30) {
      label = 'UNFAIR';
      cls = 'fair-40';
      note = 'Losing side is being taken advantage of. Hard decline.';
    } else {
      label = 'ROBBERY 🚨';
      cls = 'fair-20';
      note = 'Someone should file a police report. Absolute lopsided deal.';
    }

    const winner = diff > 0.5 ? 'B' : (diff < -0.5 ? 'A' : null);
    const winnerText = winner
      ? `<div class="fair-winner">Winner: <strong>Team ${winner}</strong> by ${pctDiff.toFixed(1)}% of value</div>`
      : `<div class="fair-winner fair-winner-even">Trade is essentially even</div>`;

    verdictEl.className = `trade-verdict ${cls}`;
    verdictEl.innerHTML = `
      <div class="fair-score-row">
        <div class="fair-score">
          <div class="fair-score-num">${fairness}</div>
          <div class="fair-score-outof">/ 100</div>
        </div>
        <div class="fair-label-block">
          <div class="fair-label">${label}</div>
          <div class="fair-note">${note}</div>
        </div>
      </div>
      ${winnerText}
      <div class="fair-breakdown">
        <div class="fair-side">
          <div class="fair-side-label">Team A gives (adjusted)</div>
          <div class="fair-side-value">${adjA.toFixed(1)}</div>
          <div class="fair-side-detail">
            Raw VORP: <strong>${rawA.toFixed(1)}</strong>
            ${noteA ? ` • ${noteA}` : ''}
          </div>
        </div>
        <div class="fair-vs">vs</div>
        <div class="fair-side">
          <div class="fair-side-label">Team B gives (adjusted)</div>
          <div class="fair-side-value">${adjB.toFixed(1)}</div>
          <div class="fair-side-detail">
            Raw VORP: <strong>${rawB.toFixed(1)}</strong>
            ${noteB ? ` • ${noteB}` : ''}
          </div>
        </div>
      </div>
      ${consolidationDetail ? `<div class="fair-consolidation">${consolidationDetail}</div>` : ''}`;
  };

  attachPlayerSearch('trade-a-search', allPlayers, (p) => { teamA.push(p); repaint(); });
  attachPlayerSearch('trade-b-search', allPlayers, (p) => { teamB.push(p); repaint(); });
  repaint();
}

/* ---------- Start / Sit (Phase 3 — Advanced) ---------- */

/* Compute weekly matchup rating (1-5 stars) and adjustment multiplier
   from opponent DEF vs POS rank + game script (Vegas spread). */
function computeMatchupRating(player, nflverse, week) {
  const result = {
    opp: null, defRank: null, spread: null, total: null,
    roof: null, temp: null, wind: null, home: null,
    matchupMult: 1.0, gameScriptMult: 1.0, weatherMult: 1.0,
    stars: 3, matchupLabel: null, weatherWarning: null,
  };

  if (!player.team || !nflverse?.gameContext) return result;

  // Look up this player's game for the given week
  const teamCtx = nflverse.gameContext[player.team];
  if (!teamCtx) return result;
  const game = teamCtx[String(week)];
  if (!game) return result;

  result.opp = game.opp;
  result.spread = game.spread;
  result.total = game.total;
  result.roof = game.roof;
  result.temp = game.temp;
  result.wind = game.wind;
  result.home = game.home;

  // Matchup: opponent's DEF vs POS rank (1 = best D, 32 = worst D)
  const defRank = nflverse.defVsPos[game.opp]?.[player.pos]?.rank;
  if (defRank != null) {
    result.defRank = defRank;
    // rank 1 = -15% (toughest), rank 32 = +15% (softest), linear
    result.matchupMult = 1.0 + ((defRank - 16.5) / 100);
    result.matchupLabel = `vs ${game.opp} DEF #${defRank}/32 ${player.pos}`;
  }

  // Game script from Vegas: positive spread = team favored
  // RBs benefit from being favored (grinding out clock);
  // WRs benefit slightly from underdog game script (garbage-time targets);
  // QBs/TEs neutral to slight favor for being favored (script projected higher)
  if (game.spread != null && Math.abs(game.spread) >= 3) {
    const favored = game.spread > 0;
    if (player.pos === 'RB') {
      result.gameScriptMult = favored ? 1.05 : 0.95;
    } else if (player.pos === 'WR') {
      result.gameScriptMult = favored ? 1.0 : 1.03;
    } else if (player.pos === 'QB') {
      result.gameScriptMult = favored ? 1.03 : 0.98;
    } else {
      result.gameScriptMult = 1.0;
    }
  }

  // Weather (outdoor games only) — wind matters more than temp
  if (game.roof === 'outdoors' || game.roof === 'open') {
    if (game.wind != null && game.wind >= 20) {
      // High wind hurts QB/WR/TE most, less RB
      const isPassing = player.pos === 'QB' || player.pos === 'WR' || player.pos === 'TE';
      result.weatherMult = isPassing ? 0.88 : 0.95;
      result.weatherWarning = `🌬 ${game.wind.toFixed(0)}mph wind`;
    } else if (game.temp != null && game.temp < 20) {
      const isPassing = player.pos === 'QB' || player.pos === 'WR' || player.pos === 'TE';
      result.weatherMult = isPassing ? 0.94 : 0.97;
      result.weatherWarning = `🥶 ${game.temp.toFixed(0)}°F`;
    }
  }

  // Convert combined multiplier to star rating
  const combined = result.matchupMult * result.gameScriptMult * result.weatherMult;
  if (combined >= 1.10) result.stars = 5;
  else if (combined >= 1.04) result.stars = 4;
  else if (combined >= 0.96) result.stars = 3;
  else if (combined >= 0.90) result.stars = 2;
  else result.stars = 1;

  return result;
}

function renderStartSit(allPlayers, container, nflverse) {
  let picks = [];
  let previewWeek = 1;   // offseason default

  container.innerHTML = `
    <div class="ss-notice">
      <strong>Advanced Start/Sit.</strong> Uses FantasyPros projections + injury probability,
      layered with nflverse signals: real DEF vs POS matchup, snap trends, target share,
      xFP regression, Vegas game script, and weather.
      ${!nflverse.available ? '<br><em>⚠ nflverse data not yet loaded — run the Update nflverse data workflow first.</em>' : ''}
    </div>

    <div class="ss-controls">
      <label for="ss-week-select">Week to analyze:</label>
      <select id="ss-week-select">
        ${Array.from({ length: 18 }, (_, i) => i + 1).map(w => `
          <option value="${w}"${w === previewWeek ? ' selected' : ''}>Week ${w}</option>
        `).join('')}
      </select>
    </div>

    <div class="ss-search-row">
      ${playerSearchHtml('ss-search', 'Search player to compare…')}
    </div>

    <div id="ss-picks"></div>
    <div id="ss-verdict"></div>

    <button class="tools-toggle" id="ss-toggle-math">
      Show me the math ▼
    </button>
    <div id="ss-math" class="tools-math hidden">
      <h4>Advanced Start/Sit — Phase 3</h4>
      <pre class="tools-formula">Score = Projected Points
      × Injury Probability
      × Matchup Factor
      × Game Script Factor
      × Weather Factor
      × Snap Trend Factor
      × Regression Factor

━━━ MATCHUP (DEF vs POS) ━━━
Opponent's rank against this position (1 = best D, 32 = worst D).
  rank 1  → 0.85× (toughest)
  rank 32 → 1.15× (softest)
Linear scale.

━━━ GAME SCRIPT (Vegas) ━━━
Uses Vegas spread. Kicks in when |spread| >= 3 points.
  RB favored by 3+  → 1.05× (grinding clock)
  RB underdog 3+    → 0.95× (abandoned rush)
  WR underdog 3+    → 1.03× (garbage-time targets)
  QB favored 3+     → 1.03× (implied higher scoring)

━━━ WEATHER (outdoor only) ━━━
  Wind >= 20 mph → 0.88× passing / 0.95× rushing
  Temp < 20°F    → 0.94× passing / 0.97× rushing
Indoor / dome games → 1.0×

━━━ SNAP TREND ━━━
Recent 3-week avg vs earlier weeks (from nflverse).
  ±5% or less  → 1.0× (no signal)
  Snap rising  → up to 1.15×
  Snap falling → down to 0.85×

━━━ REGRESSION (xFP) ━━━
Compares actual FP to expected FP (opportunity-based).
Only kicks in when gap > 15 points.
  Overperforming → discount (expect decline)
  Underperforming → boost (expect improvement)

━━━ STAR RATING ━━━
Combined matchup × game script × weather → 1-5 stars:
  ≥ 1.10 → ★★★★★
  ≥ 1.04 → ★★★★
  ≥ 0.96 → ★★★
  ≥ 0.90 → ★★
  < 0.90 → ★

━━━ CONFIDENCE ━━━
Gap between top and second score, as a % of top.
Bigger gap = higher confidence.</pre>
    </div>`;

  const toggle = document.getElementById('ss-toggle-math');
  const math = document.getElementById('ss-math');
  toggle.addEventListener('click', () => {
    const hidden = math.classList.toggle('hidden');
    toggle.textContent = hidden ? 'Show me the math ▼' : 'Hide the math ▲';
  });

  const weekSelect = document.getElementById('ss-week-select');
  weekSelect.addEventListener('change', () => {
    previewWeek = Number(weekSelect.value);
    repaint();
  });

  const computeSsScore = (p) => {
    const proj = Number(p.proj_pts) || 0;

    // Injury
    let injuryMult = 1.0;
    let injuryLabel = null;
    if (p._injury_prob != null && p._injury_prob >= 0 && p._injury_prob <= 1) {
      injuryMult = p._injury_prob;
      injuryLabel = `${(p._injury_prob * 100).toFixed(0)}% play prob`;
    } else if (p._injury && INJURY_STATUS_FALLBACK[p._injury] != null) {
      injuryMult = INJURY_STATUS_FALLBACK[p._injury];
      injuryLabel = p._injury;
    }

    // Matchup rating (this week)
    const matchup = computeMatchupRating(p, nflverse, previewWeek);

    // Snap trend
    let snapMult = 1.0, snapLabel = null;
    if (p._snap_trend != null && Math.abs(p._snap_trend) > 0.05) {
      snapMult = Math.max(0.85, Math.min(1.15, 1.0 + p._snap_trend * 0.5));
      snapLabel = p._snap_trend > 0
        ? `↑ ${(p._snap_trend * 100).toFixed(0)}%`
        : `↓ ${(p._snap_trend * 100).toFixed(0)}%`;
    }

    // Regression (xFP gap)
    let regressionMult = 1.0, regressionLabel = null;
    if (p._xfp_gap != null && Math.abs(p._xfp_gap) > 15) {
      const adj = Math.max(-0.15, Math.min(0.15, -p._xfp_gap / 200));
      regressionMult = 1.0 + adj;
      regressionLabel = p._xfp_gap > 0 ? 'regress ↓' : 'regress ↑';
    }

    // Target share (WR/TE only — for context, not scoring)
    let tgtShareLabel = null;
    if (['WR', 'TE'].includes(p.pos)) {
      const usage = nflverse?.usage?.get(normalizeName(p.name));
      if (usage && usage.recent_tgt_share > 0) {
        tgtShareLabel = `${(usage.recent_tgt_share * 100).toFixed(0)}% tgts`;
        if (usage.tgt_share_delta > 0.05) tgtShareLabel += ' ↑';
        else if (usage.tgt_share_delta < -0.05) tgtShareLabel += ' ↓';
      }
    }

    const total = proj
      * injuryMult
      * matchup.matchupMult
      * matchup.gameScriptMult
      * matchup.weatherMult
      * snapMult
      * regressionMult;

    return {
      total, proj,
      injuryMult, injuryLabel,
      matchup,
      snapMult, snapLabel,
      regressionMult, regressionLabel,
      tgtShareLabel,
    };
  };

  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

  function repaint() {
    const picksEl = document.getElementById('ss-picks');
    const verdictEl = document.getElementById('ss-verdict');

    if (!picks.length) {
      picksEl.innerHTML = '<div class="ss-empty">Add 2-4 players to compare</div>';
      verdictEl.innerHTML = '';
      return;
    }

    const scored = picks.map(p => ({ p, s: computeSsScore(p) }))
      .sort((a, b) => b.s.total - a.s.total);

    picksEl.innerHTML = `
      <div class="ss-list">
        ${scored.map((x, i) => `
          <div class="ss-card ${i === 0 ? 'ss-card-start' : ''}">
            <div class="ss-card-badge">${i === 0 ? '✓ START' : 'SIT'}</div>
            <div class="ss-card-name">${esc(x.p.name)}
              ${x.s.injuryLabel ? `<span class="trade-injury">${esc(x.s.injuryLabel)}</span>` : ''}
            </div>
            <div class="ss-card-meta">
              <span class="${_pillClass(x.p.pos)}">${esc(x.p.pos)}</span>
              <span>${esc(x.p.team || '')}</span>
              ${x.p.bye ? `<span>BYE ${esc(x.p.bye)}</span>` : ''}
            </div>

            ${x.s.matchup.opp ? `
              <div class="ss-matchup">
                <div class="ss-matchup-line">
                  <span class="ss-stars">${stars(x.s.matchup.stars)}</span>
                  <span class="ss-opp">${x.s.matchup.home ? 'vs' : '@'} ${esc(x.s.matchup.opp)}</span>
                  ${x.s.matchup.defRank != null ? `<span class="ss-def-rank">D#${x.s.matchup.defRank}</span>` : ''}
                </div>
                <div class="ss-matchup-details">
                  ${x.s.matchup.spread != null ? `<span>${x.s.matchup.spread > 0 ? '−' + x.s.matchup.spread.toFixed(1) + ' fav' : '+' + Math.abs(x.s.matchup.spread).toFixed(1) + ' dog'}</span>` : ''}
                  ${x.s.matchup.total != null ? `<span>O/U ${x.s.matchup.total.toFixed(1)}</span>` : ''}
                  ${x.s.matchup.weatherWarning ? `<span class="ss-weather-warn">${esc(x.s.matchup.weatherWarning)}</span>` : ''}
                </div>
              </div>` : ''}

            <div class="ss-signals">
              ${x.s.tgtShareLabel ? `<span class="chip chip-tgt">${esc(x.s.tgtShareLabel)}</span>` : ''}
              ${x.s.snapLabel ? `<span class="chip chip-snap">snap ${esc(x.s.snapLabel)}</span>` : ''}
              ${x.s.regressionLabel ? `<span class="chip chip-regression">${esc(x.s.regressionLabel)}</span>` : ''}
            </div>

            <div class="ss-card-stats">
              <div><span class="lbl">ECR</span><span class="val">${x.p.rank ?? '—'}</span></div>
              <div><span class="lbl">Proj</span><span class="val">${x.s.proj != null ? Math.round(x.s.proj) : '—'}</span></div>
              <div><span class="lbl">Score</span><span class="val gold">${x.s.total.toFixed(1)}</span></div>
            </div>
            <button class="ss-remove" data-idx="${picks.indexOf(x.p)}">✕</button>
          </div>`).join('')}
      </div>`;

    picksEl.querySelectorAll('.ss-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        picks.splice(Number(btn.dataset.idx), 1);
        repaint();
      });
    });

    if (scored.length >= 2) {
      const top = scored[0], second = scored[1];
      const gap = top.s.total > 0 ? (top.s.total - second.s.total) / top.s.total : 0;
      const confidence = Math.min(99, Math.max(50, gap * 100 + 50));
      verdictEl.innerHTML = `
        <div class="ss-verdict">
          <div class="ss-verdict-title">START <strong>${esc(top.p.name)}</strong></div>
          <div class="ss-verdict-conf">${confidence.toFixed(0)}% confidence • Week ${previewWeek}</div>
        </div>`;
    } else {
      verdictEl.innerHTML = '<div class="ss-empty">Add one more player to see a verdict</div>';
    }
  }

  attachPlayerSearch('ss-search', allPlayers, (p) => {
    if (picks.length >= 4) picks.shift();
    picks.push(p);
    repaint();
  });
  repaint();
}

/* ---------- Trade Finder ---------- */

/* Match a Sleeper roster entry to FP player data by normalized name.
   Returns the FP player object (with _injury attached), or null. */
function matchFpPlayer(rosterEntry, fpPlayers) {
  if (!rosterEntry?.name) return null;
  const normName = normalizeName(rosterEntry.name);
  return fpPlayers.find(p => normalizeName(p.name) === normName) || null;
}

/* Analyze a team's positional strength using VBD.
   Returns { totalByPos, starterValue, roster } for the team. */
function analyzeTeamStrength(rosterNames, fpPlayers, baselines) {
  // Starting lineup composition for 12-team full PPR
  const STARTERS = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 };

  const roster = [];
  rosterNames.forEach(entry => {
    const fp = matchFpPlayer(entry, fpPlayers);
    if (fp) roster.push(fp);
  });

  // Group by position, sort by rank
  const byPos = { QB: [], RB: [], WR: [], TE: [], K: [], DST: [] };
  roster.forEach(p => {
    if (byPos[p.pos]) byPos[p.pos].push(p);
  });
  Object.keys(byPos).forEach(pos => {
    byPos[pos].sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999));
  });

  // Starter value: sum of top-N VORP at each position
  const starterValue = {};
  ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].forEach(pos => {
    const n = STARTERS[pos] || 1;
    const starters = byPos[pos].slice(0, n);
    starterValue[pos] = starters.reduce((s, p) => s + computePlayerValue(p, baselines).value, 0);
  });

  // Bench depth (players 2-4 at RB/WR/TE, for flex/injury insurance)
  const depthValue = {};
  ['RB', 'WR', 'TE'].forEach(pos => {
    const bench = byPos[pos].slice(STARTERS[pos] || 1, (STARTERS[pos] || 1) + 3);
    depthValue[pos] = bench.reduce((s, p) => s + computePlayerValue(p, baselines).value, 0);
  });

  return { byPos, starterValue, depthValue, roster };
}

/* Find trades between myTeam and otherTeam.
   Returns array of { give, get, fairness, myGain, theirGain, verdict } sorted by mutual improvement. */
function findTradesBetweenTeams(myTeam, otherTeam, myAnalysis, otherAnalysis, baselines) {
  const trades = [];
  const POSITIONS_TO_TRADE = ['QB', 'RB', 'WR', 'TE'];

  // For each of MY weak positions, look at THEIR strength there
  POSITIONS_TO_TRADE.forEach(myWeakPos => {
    const myStarters = myAnalysis.byPos[myWeakPos].slice(0, myWeakPos === 'RB' || myWeakPos === 'WR' ? 3 : 2);
    if (!myStarters.length) return;
    const myWeakestStarter = myStarters[myStarters.length - 1]; // My WORST starter at this position
    if (!myWeakestStarter) return;
    const myWeakestVal = computePlayerValue(myWeakestStarter, baselines).value;

    // Their surplus at this position — players they don't NEED as starters
    const theirBenchStrength = (otherAnalysis.byPos[myWeakPos] || []).slice(myWeakPos === 'RB' || myWeakPos === 'WR' ? 2 : 1, 5);

    theirBenchStrength.forEach(theirPlayer => {
      const theirVal = computePlayerValue(theirPlayer, baselines).value;
      // Only useful if their surplus > my weakest starter
      if (theirVal <= myWeakestVal * 1.1) return;

      // What do I give up? Find a position where I'M strong and they're weak
      POSITIONS_TO_TRADE.forEach(myStrongPos => {
        if (myStrongPos === myWeakPos) return;
        const mySurplus = (myAnalysis.byPos[myStrongPos] || []).slice(myStrongPos === 'RB' || myStrongPos === 'WR' ? 2 : 1, 5);

        mySurplus.forEach(myPlayer => {
          const myPlayerVal = computePlayerValue(myPlayer, baselines).value;
          const theirWeakestStarter = (otherAnalysis.byPos[myStrongPos] || [])[myStrongPos === 'RB' || myStrongPos === 'WR' ? 2 : 1];
          // Only useful if my surplus > their weakest starter at that position
          if (!theirWeakestStarter) return;
          const theirWeakestVal = computePlayerValue(theirWeakestStarter, baselines).value;
          if (myPlayerVal <= theirWeakestVal * 1.1) return;

          // Fairness check
          const diff = Math.abs(myPlayerVal - theirVal);
          const higher = Math.max(myPlayerVal, theirVal, 0.01);
          const fairness = Math.max(0, Math.min(100, Math.round(100 - (diff / higher * 100))));

          // Only include reasonably fair trades
          if (fairness < 75) return;

          // Compute mutual improvement
          const myImprovementPos = theirVal - myWeakestVal;        // I gain by upgrading my weak spot
          const myImprovementLoss = -(myPlayerVal - myPlayerVal * 0.7);  // I lose bench depth at strong position
          const myGain = myImprovementPos + myImprovementLoss;

          const theirImprovementPos = myPlayerVal - theirWeakestVal;
          const theirImprovementLoss = -(theirVal - theirVal * 0.7);
          const theirGain = theirImprovementPos + theirImprovementLoss;

          // Both must benefit
          if (myGain < 5 || theirGain < 5) return;

          trades.push({
            give: myPlayer,
            get: theirPlayer,
            fairness,
            myGain,
            theirGain,
            myWeakPos,
            myStrongPos,
            mutualBenefit: myGain + theirGain,
          });
        });
      });
    });
  });

  return trades.sort((a, b) => b.mutualBenefit - a.mutualBenefit);
}

function renderTradeFinder(allPlayers, baselines, teams, container, metaEl) {
  if (!teams || !teams.size) {
    container.innerHTML = errBox("Roster data unavailable. Trade Finder needs Sleeper players DB — trigger 'Update Sleeper players DB' workflow first.");
    return;
  }

  const teamList = Array.from(teams.values());
  const teamsWithRosters = teamList.filter(t => t.roster_names && t.roster_names.length > 0);

  if (metaEl) {
    metaEl.textContent = `${teamsWithRosters.length} rosters loaded • VBD analysis`;
  }

  if (!teamsWithRosters.length) {
    container.innerHTML = empty("No rosters loaded yet. If you just joined the league mid-week this can happen. Trigger 'Update Sleeper players DB' workflow and refresh.");
    return;
  }

  // Sort teams alphabetically by name for the dropdown
  const sortedTeams = [...teamsWithRosters].sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''));
  const defaultTeamId = sortedTeams[0].roster_id;

  container.innerHTML = `
    <div class="finder-controls">
      <label for="finder-team-select">Your team:</label>
      <select id="finder-team-select">
        ${sortedTeams.map(t => `<option value="${t.roster_id}">${esc(t.team_name)}</option>`).join('')}
      </select>
    </div>

    <div id="finder-analysis"></div>
    <div id="finder-trades"></div>`;

  const paint = () => {
    const select = document.getElementById('finder-team-select');
    const analysisEl = document.getElementById('finder-analysis');
    const tradesEl = document.getElementById('finder-trades');

    const myTeamId = Number(select.value);
    const myTeam = teams.get(myTeamId);
    if (!myTeam || !myTeam.roster_names) {
      analysisEl.innerHTML = empty("No roster for this team.");
      tradesEl.innerHTML = '';
      return;
    }

    const myAnalysis = analyzeTeamStrength(myTeam.roster_names, allPlayers, baselines);

    // Show positional strength
    analysisEl.innerHTML = `
      <div class="finder-strength">
        <h3>${esc(myTeam.team_name)} — Positional Strength</h3>
        <div class="finder-strength-grid">
          ${['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map(pos => {
            const val = myAnalysis.starterValue[pos] || 0;
            const players = (myAnalysis.byPos[pos] || []).slice(0, pos === 'RB' || pos === 'WR' ? 3 : 1);
            return `
              <div class="finder-strength-pos">
                <div class="finder-strength-label">
                  <span class="${_pillClass(pos)}">${pos}</span>
                  <span class="finder-strength-val">${val.toFixed(0)}</span>
                </div>
                <div class="finder-strength-players">
                  ${players.map(p => `<div>${esc(p.name)} <span class="dim">(${p.rank || '—'})</span></div>`).join('') || '<div class="dim">No starters</div>'}
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;

    // Find trades against every other team
    tradesEl.innerHTML = loading("Scanning trades…");
    setTimeout(() => {
      const allTrades = [];
      teamsWithRosters.forEach(other => {
        if (other.roster_id === myTeamId) return;
        const otherAnalysis = analyzeTeamStrength(other.roster_names, allPlayers, baselines);
        const trades = findTradesBetweenTeams(myTeam, other, myAnalysis, otherAnalysis, baselines);
        trades.forEach(t => t.otherTeam = other);
        allTrades.push(...trades);
      });

      const topTrades = allTrades
        .sort((a, b) => b.mutualBenefit - a.mutualBenefit)
        .slice(0, 12);

      if (!topTrades.length) {
        tradesEl.innerHTML = empty("No mutual-benefit trades found. Your roster is either well-balanced or others don't have complementary needs.");
        return;
      }

      tradesEl.innerHTML = `
        <h3 class="finder-trades-title">Suggested trades (top ${topTrades.length}):</h3>
        <div class="finder-trades-list">
          ${topTrades.map(t => {
            const giveV = computePlayerValue(t.give, baselines);
            const getV = computePlayerValue(t.get, baselines);
            return `
              <div class="finder-trade">
                <div class="finder-trade-partner">
                  <span class="finder-vs-team">Trade with ${esc(t.otherTeam.team_name)}</span>
                  <span class="finder-fairness fair-${Math.floor(t.fairness / 10) * 10}">${t.fairness}/100 fair</span>
                </div>
                <div class="finder-trade-body">
                  <div class="finder-trade-side finder-give">
                    <div class="finder-trade-side-label">You give</div>
                    <div class="finder-trade-player">
                      <div class="finder-trade-name">${esc(t.give.name)}</div>
                      <div class="finder-trade-meta">
                        <span class="${_pillClass(t.give.pos)}">${esc(t.give.pos)}</span>
                        <span>ECR #${t.give.rank || '—'}</span>
                        <span class="finder-val">VORP ${giveV.value.toFixed(1)}</span>
                      </div>
                    </div>
                  </div>
                  <div class="finder-trade-arrow">⇄</div>
                  <div class="finder-trade-side finder-get">
                    <div class="finder-trade-side-label">You get</div>
                    <div class="finder-trade-player">
                      <div class="finder-trade-name">${esc(t.get.name)}</div>
                      <div class="finder-trade-meta">
                        <span class="${_pillClass(t.get.pos)}">${esc(t.get.pos)}</span>
                        <span>ECR #${t.get.rank || '—'}</span>
                        <span class="finder-val">VORP ${getV.value.toFixed(1)}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="finder-trade-benefit">
                  <span>Your gain: <strong class="fair-winner-gain">+${t.myGain.toFixed(1)}</strong> at ${t.myWeakPos}</span>
                  <span class="dim">•</span>
                  <span>Their gain: <strong>+${t.theirGain.toFixed(1)}</strong> at ${t.myStrongPos}</span>
                </div>
              </div>`;
          }).join('')}
        </div>
        <p class="finder-note">
          Trades ranked by mutual benefit (sum of both teams' improvement). Only shows trades with fairness ≥ 75/100
          where <strong>both</strong> teams improve their weakest starting position.
        </p>`;
    }, 50);
  };

  document.getElementById('finder-team-select').addEventListener('change', paint);
  paint();
}

/* ============================================================
   WAIVER WIRE (Phase 5) — league-wide, no personalization
   ============================================================ */

async function renderWaiver() {
  const metaEl = document.getElementById("waiver-meta");
  const controlsEl = document.getElementById("waiver-controls");
  const bodyEl = document.getElementById("waiver-body");
  bodyEl.innerHTML = loading("Loading players + rosters + nflverse data…");

  // Load everything
  const dk = await getDraftKit();
  if (!dk?.rankings?.overall) {
    bodyEl.innerHTML = errBox("Draft Kit unavailable.");
    return;
  }

  const allPlayers = dk.rankings.overall.filter(p => p.name && p.pos);
  const baselines = computeBaselines(dk.rankings);

  // Injuries
  const injuries = await getFantasyProsInjuries();
  const injuryByName = new Map();
  (injuries.injuries || []).forEach(inj => {
    if (!inj.name) return;
    const prob = inj.probability_of_playing != null && inj.probability_of_playing !== ''
      ? parseFloat(inj.probability_of_playing) : null;
    injuryByName.set(normalizeName(inj.name), {
      status: inj.status || null,
      prob: (prob != null && !isNaN(prob)) ? prob : null,
    });
  });
  allPlayers.forEach(p => {
    const inj = injuryByName.get(normalizeName(p.name));
    p._injury = inj?.status || null;
    p._injury_prob = inj?.prob != null ? inj.prob : null;
  });

  // nflverse enrichment
  const nflverse = await loadNflverseData();
  if (nflverse.available) {
    allPlayers.forEach(p => enrichPlayer(p, nflverse));
  }

  // League roster lookup (which players are owned)
  let teams = null;
  try {
    teams = await window.Sleeper.buildTeamsWithRosters();
  } catch (_) {}

  const rosteredNames = new Set();
  const ownerByName = new Map();
  if (teams) {
    for (const t of teams.values()) {
      (t.roster_names || []).forEach(entry => {
        const key = normalizeName(entry.name);
        rosteredNames.add(key);
        ownerByName.set(key, t.team_name);
      });
    }
  }
  allPlayers.forEach(p => {
    const key = normalizeName(p.name);
    p._available = !rosteredNames.has(key);
    p._owner = ownerByName.get(key) || null;
  });

  const avail = allPlayers.filter(p => p._available).length;
  const isOffseason = !teams || rosteredNames.size === 0;
  metaEl.textContent = isOffseason
    ? `Offseason mode — showing all fantasy-relevant players (${allPlayers.length}). Availability activates once your league drafts.`
    : `${avail} of ${allPlayers.length} players available in your league • Updated ${dk.fetched_at ? relTime(dk.fetched_at) : 'recently'}`;

  // Controls
  let positionFilter = 'ALL';
  let availableOnly = !isOffseason;   // default ON in-season, OFF offseason

  controlsEl.innerHTML = `
    <div class="waiver-pos-tabs">
      ${['ALL', 'QB', 'RB', 'WR', 'TE'].map(pos => `
        <button class="waiver-pos-tab ${pos === positionFilter ? 'active' : ''}" data-pos="${pos}">${pos}</button>
      `).join('')}
    </div>
    <label class="waiver-toggle">
      <input type="checkbox" id="waiver-avail-only" ${availableOnly ? 'checked' : ''}${isOffseason ? ' disabled' : ''}>
      Only show available players
    </label>`;

  const paint = () => {
    // Filter based on controls
    const filtered = allPlayers.filter(p => {
      if (positionFilter !== 'ALL' && p.pos !== positionFilter) return false;
      if (availableOnly && !p._available) return false;
      return true;
    });

    bodyEl.innerHTML = `
      <section class="waiver-section">
        <div class="waiver-section-head">
          <h3>🚀 Snap Count Risers</h3>
          <span class="waiver-section-note">Top jumpers in offensive snap % this week</span>
        </div>
        <div class="waiver-cards" id="waiver-snap-risers"></div>
      </section>

      <section class="waiver-section">
        <div class="waiver-section-head">
          <h3>🎯 Target Share Explosions</h3>
          <span class="waiver-section-note">WRs/TEs seeing routes and volume spike</span>
        </div>
        <div class="waiver-cards" id="waiver-target-share"></div>
      </section>

      <section class="waiver-section">
        <div class="waiver-section-head">
          <h3>⚡ Positive Regression Candidates</h3>
          <span class="waiver-section-note">Underperforming their expected fantasy points — expect production to rise</span>
        </div>
        <div class="waiver-cards" id="waiver-positive-reg"></div>
      </section>

      <section class="waiver-section">
        <div class="waiver-section-head">
          <h3>📉 Negative Regression Candidates</h3>
          <span class="waiver-section-note">Outperforming their expected — production likely to fall</span>
        </div>
        <div class="waiver-cards" id="waiver-negative-reg"></div>
      </section>

      <section class="waiver-section">
        <div class="waiver-section-head">
          <h3>📋 All Players (by ECR)</h3>
          <span class="waiver-section-note">${filtered.length} shown • sorted by FantasyPros consensus rank</span>
        </div>
        <div class="waiver-list" id="waiver-all-list"></div>
      </section>`;

    // Populate sections
    const cardHtml = (p, signalHtml) => {
      const availBadge = p._available
        ? '<span class="waiver-avail waiver-free">Available</span>'
        : `<span class="waiver-avail waiver-owned">${esc(p._owner || 'Rostered')}</span>`;
      return `
        <div class="waiver-card">
          <div class="waiver-card-top">
            <div class="waiver-card-name">
              ${esc(p.name)}
              ${p._injury ? `<span class="trade-injury">${esc(p._injury)}</span>` : ''}
            </div>
            <div class="waiver-card-rank">ECR #${p.rank || '—'}</div>
          </div>
          <div class="waiver-card-meta">
            <span class="${_pillClass(p.pos)}">${esc(p.pos)}</span>
            <span>${esc(p.team || '')}</span>
            ${availBadge}
          </div>
          ${signalHtml ? `<div class="waiver-card-signal">${signalHtml}</div>` : ''}
        </div>`;
    };

    // 1. Snap Risers — sort by latest snap delta
    const snapRisers = filtered
      .filter(p => p._latest_snap_delta != null && p._latest_snap_delta > 0.10)
      .sort((a, b) => b._latest_snap_delta - a._latest_snap_delta)
      .slice(0, 15);
    document.getElementById('waiver-snap-risers').innerHTML = snapRisers.length
      ? snapRisers.map(p => cardHtml(p,
          `<strong>+${(p._latest_snap_delta * 100).toFixed(0)}%</strong> snap share (now ${(p._latest_snap_pct * 100).toFixed(0)}%) week ${p._latest_snap_week}`
        )).join('')
      : '<div class="waiver-empty">No snap risers yet — populates once games play.</div>';

    // 2. Target Share Explosions — WR/TE with delta > 5%
    const tgtShare = filtered
      .filter(p => ['WR', 'TE'].includes(p.pos) && p._tgt_share_delta != null && p._tgt_share_delta > 0.05)
      .sort((a, b) => b._tgt_share_delta - a._tgt_share_delta)
      .slice(0, 12);
    document.getElementById('waiver-target-share').innerHTML = tgtShare.length
      ? tgtShare.map(p => cardHtml(p,
          `<strong>+${(p._tgt_share_delta * 100).toFixed(0)}%</strong> targets (now ${(p._recent_tgt_share * 100).toFixed(0)}% of team)`
        )).join('')
      : '<div class="waiver-empty">No target share explosions yet — populates once games play.</div>';

    // 3. Positive Regression — negative xFP gap
    const positive = filtered
      .filter(p => p._xfp_gap != null && p._xfp_gap < -10)
      .sort((a, b) => a._xfp_gap - b._xfp_gap)
      .slice(0, 12);
    document.getElementById('waiver-positive-reg').innerHTML = positive.length
      ? positive.map(p => cardHtml(p,
          `<strong>${p._xfp_gap.toFixed(0)}</strong> pts below expected — production should rise`
        )).join('')
      : '<div class="waiver-empty">No positive regression candidates — populates with xFP data in-season.</div>';

    // 4. Negative Regression — positive xFP gap
    const negative = filtered
      .filter(p => p._xfp_gap != null && p._xfp_gap > 10)
      .sort((a, b) => b._xfp_gap - a._xfp_gap)
      .slice(0, 12);
    document.getElementById('waiver-negative-reg').innerHTML = negative.length
      ? negative.map(p => cardHtml(p,
          `<strong>+${p._xfp_gap.toFixed(0)}</strong> pts above expected — production likely to fall`
        )).join('')
      : '<div class="waiver-empty">No negative regression candidates — populates with xFP data in-season.</div>';

    // 5. All Players list — sorted by ECR, capped to first 100
    const sorted = filtered.sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999)).slice(0, 100);
    document.getElementById('waiver-all-list').innerHTML = sorted.length
      ? sorted.map(p => {
          const chips = [];
          if (p._latest_snap_delta != null && p._latest_snap_delta > 0.10) chips.push(`<span class="chip chip-snap">snap ↑${(p._latest_snap_delta*100).toFixed(0)}%</span>`);
          if (p._tgt_share_delta != null && p._tgt_share_delta > 0.05) chips.push(`<span class="chip chip-tgt">tgt ↑${(p._tgt_share_delta*100).toFixed(0)}%</span>`);
          if (p._xfp_gap != null && Math.abs(p._xfp_gap) > 10) {
            chips.push(`<span class="chip chip-regression">${p._xfp_gap > 0 ? 'regress ↓' : 'regress ↑'}</span>`);
          }
          const availBadge = p._available
            ? '<span class="waiver-avail waiver-free">Available</span>'
            : `<span class="waiver-avail waiver-owned" title="${esc(p._owner || '')}">Rostered</span>`;
          return `
            <div class="waiver-row">
              <div class="waiver-row-rank">${p.rank || '—'}</div>
              <div class="waiver-row-main">
                <div class="waiver-row-name">${esc(p.name)}
                  ${p._injury ? `<span class="trade-injury">${esc(p._injury)}</span>` : ''}
                </div>
                <div class="waiver-row-meta">
                  <span class="${_pillClass(p.pos)}">${esc(p.pos)}</span>
                  <span>${esc(p.team || '')}</span>
                  ${p.bye ? `<span>Bye ${esc(String(p.bye))}</span>` : ''}
                </div>
                ${chips.length ? `<div class="waiver-row-chips">${chips.join('')}</div>` : ''}
              </div>
              <div class="waiver-row-avail">${availBadge}</div>
            </div>`;
        }).join('')
      : '<div class="waiver-empty">No players match current filters.</div>';
  };

  // Wire controls
  controlsEl.querySelectorAll('.waiver-pos-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      positionFilter = btn.dataset.pos;
      controlsEl.querySelectorAll('.waiver-pos-tab').forEach(b => b.classList.toggle('active', b === btn));
      paint();
    });
  });
  const availCheckbox = document.getElementById('waiver-avail-only');
  if (availCheckbox) {
    availCheckbox.addEventListener('change', () => {
      availableOnly = availCheckbox.checked;
      paint();
    });
  }

  paint();
}

/* ============================================================
   WALL OF SHAME + DONKEY OF THE WEEK + COACH OF THE WEEK (Phase 6)
   ============================================================ */

/* Extract starting slot counts from league.roster_positions.
   Filters out BN/IR/TAXI. Returns {QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DEF: 1} shape. */
function extractStartingSlots(rosterPositions) {
  const slots = {};
  (rosterPositions || []).forEach(pos => {
    if (['BN', 'IR', 'TAXI', 'RES'].includes(pos)) return;
    const key = (pos === 'DST') ? 'DEF' : pos;
    slots[key] = (slots[key] || 0) + 1;
  });
  return slots;
}

/* Whether a player's primary position is eligible for a given slot type. */
function slotEligible(pos, slotType) {
  if (slotType === 'FLEX') return ['RB', 'WR', 'TE'].includes(pos);
  if (slotType === 'SUPER_FLEX') return ['QB', 'RB', 'WR', 'TE'].includes(pos);
  if (slotType === 'REC_FLEX' || slotType === 'WRRB_FLEX') return ['RB', 'WR'].includes(pos);
  if (slotType === 'DEF') return pos === 'DEF' || pos === 'DST';
  return pos === slotType;
}

/* Compute the highest-scoring legal lineup from a matchup's full roster.
   Greedy fill: exclusive slots first, then FLEX. */
function computeOptimalLineup(matchup, playerPosMap, startingSlots) {
  const players = (matchup.players || []).map(pid => ({
    id: pid,
    pos: playerPosMap[pid] || 'UNK',
    points: Number(matchup.players_points?.[pid] || 0),
  }));
  players.sort((a, b) => b.points - a.points);

  const usedIds = new Set();
  const lineup = [];
  // Fill exclusive positions first — FLEX / SUPER_FLEX last
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
  return {
    lineup,
    total: lineup.reduce((s, p) => s + p.points, 0),
  };
}

/* Find the single biggest missed swap: a bench player who outscored a starter
   at the same primary position. Returns null if no positive swap exists. */
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
      // Exact position match (simple + defensible)
      if (starterPos !== benchPos) continue;
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

/* Analyze a single week: identify donkey, coach, lowest scorer. */
function analyzeWeek(matchups, playerPosMap, startingSlots) {
  // Group into head-to-head pairs by matchup_id
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
    const marginA = ptsB - ptsA;   // positive if A lost
    const marginB = -marginA;

    // Donkey: LOST + could have WON with optimal lineup
    if (ptsA < ptsB && missedA >= marginA && ptsB > 0) {
      donkeyCandidates.push({
        roster_id: a.roster_id, actual: ptsA, optimal: optA.total,
        missed: missedA, margin: marginA, opp_score: ptsB, opp_roster_id: b.roster_id,
        swap: findBiggestMissedSwap(a, playerPosMap),
      });
    }
    if (ptsB < ptsA && missedB >= marginB && ptsA > 0) {
      donkeyCandidates.push({
        roster_id: b.roster_id, actual: ptsB, optimal: optB.total,
        missed: missedB, margin: marginB, opp_score: ptsA, opp_roster_id: a.roster_id,
        swap: findBiggestMissedSwap(b, playerPosMap),
      });
    }

    // Coach of Week candidates — winners with high efficiency
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

  return { donkey, coach, lowest, teamResults };
}

/* ---------- render ---------- */

async function renderShame() {
  const metaEl = document.getElementById("shame-meta");
  const bodyEl = document.getElementById("shame-body");
  bodyEl.innerHTML = loading("Loading matchup history…");

  const [state, users, rosters, sleeperPlayers, league] = await Promise.all([
    window.Sleeper.getState(),
    window.Sleeper.getUsers(),
    window.Sleeper.getRosters(),
    window.Sleeper.getSleeperPlayers(),
    window.Sleeper.getLeague(),
  ]);

  const teams = window.Sleeper.buildTeamMap(users, rosters);
  const currentWeek = state?.week || 0;
  const startingSlots = extractStartingSlots(league?.roster_positions);

  // Build position lookup from Sleeper players DB
  const playerPos = {};
  const playerName = {};
  Object.entries(sleeperPlayers?.players || {}).forEach(([id, p]) => {
    playerPos[id] = p.pos;
    playerName[id] = p.name;
  });

  if (currentWeek < 1) {
    metaEl.textContent = 'Offseason';
    bodyEl.innerHTML = `
      <div class="shame-empty">
        <div class="shame-empty-scroll">☙ ❧</div>
        <h3>The Council awaits games to judge</h3>
        <p>Every Tuesday morning after MNF, the Council convenes to name:</p>
        <ul>
          <li><strong>His Grace</strong> — winner with the highest lineup efficiency</li>
          <li><strong>The Donkey</strong> — manager who lost by less than the points left upon the bench</li>
          <li><strong>The Peasant</strong> — lowest scorer in all the land</li>
        </ul>
        <p><em>Standings, season leaders, and weekly history all populate automatically as games play. Check back after Week I (Sept 7 games).</em></p>
      </div>`;
    return;
  }

  // Fetch matchups for all completed weeks in parallel
  const weeks = Array.from({ length: currentWeek }, (_, i) => i + 1);
  const allMatchups = await Promise.all(
    weeks.map(w => window.Sleeper.getMatchups(w).catch(() => null))
  );

  // Analyze each week that has scoring
  const weeklyAnalyses = [];
  weeks.forEach((week, idx) => {
    const m = allMatchups[idx];
    if (!m?.length) return;
    if (m.every(x => (x.points || 0) === 0)) return;
    const a = analyzeWeek(m, playerPos, startingSlots);
    if (a) weeklyAnalyses.push({ week, ...a });
  });

  if (!weeklyAnalyses.length) {
    metaEl.textContent = `Week ${currentWeek}`;
    bodyEl.innerHTML = empty("No completed weeks with scoring yet.");
    return;
  }

  metaEl.textContent = `${weeklyAnalyses.length} week${weeklyAnalyses.length !== 1 ? 's' : ''} analyzed`;

  // Season aggregates
  const donkeyCount = new Map();
  const shameCount = new Map();
  const coachCount = new Map();
  const seasonPoints = new Map();
  for (const wa of weeklyAnalyses) {
    if (wa.donkey) donkeyCount.set(wa.donkey.roster_id, (donkeyCount.get(wa.donkey.roster_id) || 0) + 1);
    if (wa.lowest) shameCount.set(wa.lowest.roster_id, (shameCount.get(wa.lowest.roster_id) || 0) + 1);
    if (wa.coach) coachCount.set(wa.coach.roster_id, (coachCount.get(wa.coach.roster_id) || 0) + 1);
    for (const r of wa.teamResults) seasonPoints.set(r.roster_id, (seasonPoints.get(r.roster_id) || 0) + r.points);
  }

  const teamName = (rid) => teams.get(rid)?.team_name || `Roster ${rid}`;
  const teamAvatar = (rid) => avatarUrl(teams.get(rid));

  // Most recent week's donkey/coach/lowest
  const latest = weeklyAnalyses[weeklyAnalyses.length - 1];

  // Season leaders
  const seasonDonkey = Array.from(donkeyCount.entries()).sort((a, b) => b[1] - a[1])[0];
  const seasonShame = Array.from(shameCount.entries()).sort((a, b) => b[1] - a[1])[0];
  const seasonPointsSorted = Array.from(seasonPoints.entries()).sort((a, b) => a[1] - b[1]);   // ascending = worst first
  const seasonLowestTotal = seasonPointsSorted[0];

  // ------- render -------
  bodyEl.innerHTML = `
    <div class="shame-page-subtitle">Proclamations from the Council of Twelve Guys and One Cup · Week ${roman(latest.week)}, ${new Date().getFullYear()}</div>

    ${latest.coach ? `
      <div class="section-marker">━━━━━ TO BE HONOURED ━━━━━</div>
      ${coachCardHtml(latest.coach, latest.week, teams)}` : ''}

    ${(latest.donkey || latest.lowest) ? `
      <div class="section-marker">━━━━━ TO BE PUNISHED ━━━━━</div>
      ${latest.donkey ? donkeyCardHtml(latest.donkey, latest.week, teams, playerName) : ''}
      ${latest.lowest ? lowestCardHtml(latest.lowest, latest.week, teams) : ''}` : ''}

    <section class="shame-section">
      <div class="shame-section-head">
        <h3>Season Standings</h3>
      </div>
      <table class="stats-table shame-standings">
        <thead>
          <tr>
            <th>Team</th>
            <th class="num">The Donkey</th>
            <th class="num">The Peasant</th>
            <th class="num">His Grace</th>
            <th class="num">Season pts</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from(teams.values()).sort((a, b) => {
            const dA = donkeyCount.get(a.roster_id) || 0;
            const dB = donkeyCount.get(b.roster_id) || 0;
            if (dA !== dB) return dB - dA;
            const sA = shameCount.get(a.roster_id) || 0;
            const sB = shameCount.get(b.roster_id) || 0;
            if (sA !== sB) return sB - sA;
            return (seasonPoints.get(a.roster_id) || 0) - (seasonPoints.get(b.roster_id) || 0);
          }).map(t => {
            const d = donkeyCount.get(t.roster_id) || 0;
            const s = shameCount.get(t.roster_id) || 0;
            const c = coachCount.get(t.roster_id) || 0;
            const p = seasonPoints.get(t.roster_id) || 0;
            const isSeasonDonkey = seasonDonkey && t.roster_id === seasonDonkey[0] && d > 0;
            return `
              <tr class="${isSeasonDonkey ? 'shame-season-donkey' : ''}">
                <td>
                  <div class="team-cell">
                    <img class="avatar-sm" src="${esc(avatarUrl(t))}" alt="" onerror="this.src='assets/img/logo.jpg'">
                    ${esc(t.team_name)}
                    ${isSeasonDonkey ? '<span class="shame-badge">SEASON DONKEY</span>' : ''}
                  </div>
                </td>
                <td class="num">${d || '—'}</td>
                <td class="num">${s || '—'}</td>
                <td class="num">${c || '—'}</td>
                <td class="num">${p ? p.toFixed(1) : '—'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${seasonLowestTotal ? `
        <div class="shame-season-lowest">
          Season points floor: <strong>${esc(teamName(seasonLowestTotal[0]))}</strong> — ${seasonLowestTotal[1].toFixed(1)} pts
        </div>` : ''}
    </section>

    <section class="shame-section">
      <div class="shame-section-head">
        <h3>Weekly History</h3>
      </div>
      <div class="shame-weeks">
        ${weeklyAnalyses.slice().reverse().map(wa => `
          <div class="shame-week-card">
            <div class="shame-week-title">Week ${roman(wa.week)}</div>
            <div class="shame-week-body">
              <div class="shame-week-line">
                <span class="shame-week-lbl">His Grace:</span>
                <span>${wa.coach ? esc(teamName(wa.coach.roster_id)) + ` (${(wa.coach.efficiency*100).toFixed(0)}%)` : '—'}</span>
              </div>
              <div class="shame-week-line">
                <span class="shame-week-lbl">The Donkey:</span>
                <span>${wa.donkey ? esc(teamName(wa.donkey.roster_id)) + ` (missed ${wa.donkey.missed.toFixed(1)})` : '<em class="dim">nobody qualified</em>'}</span>
              </div>
              <div class="shame-week-line">
                <span class="shame-week-lbl">The Peasant:</span>
                <span>${wa.lowest ? esc(teamName(wa.lowest.roster_id)) + ` (${wa.lowest.points.toFixed(1)})` : '—'}</span>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </section>`;

  // Roman numeral converter for week numbers
  function roman(num) {
    const romans = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII'];
    return romans[num] || String(num);
  }

  function ordinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }

  function monthName(m) {
    return ['January','February','March','April','May','June','July','August','September','October','November','December'][m] || '';
  }

  // Helper renderers — ceremonial style (Concept 3)

  function coachCardHtml(c, week) {
    const t = teams.get(c.roster_id);
    const managerName = t?.display_name || t?.username || 'manager';
    const now = new Date();
    return `
      <div class="ceremony">
        <div class="ceremony-scroll-top">☙ ❧</div>
        <div class="ceremony-preamble">
          Presented this ${now.getDate()}<sup>${ordinalSuffix(now.getDate())}</sup> day of ${monthName(now.getMonth())}, in the Year of Our Lord Two Thousand Twenty-${now.getFullYear() % 100 === 26 ? 'Six' : (now.getFullYear() % 100)},<br>
          before the Council of Twelve Guys and One Cup, it is hereby proclaimed:
        </div>
        <div class="ceremony-title">HIS GRACE OF WEEK ${roman(week)}</div>
        <div class="ceremony-name">${esc(teamName(c.roster_id))}</div>
        <div class="ceremony-manager">Managed by ${esc(managerName)}</div>
        <div class="ceremony-body">
          For statistical excellence, sound roster construction, and the not-inconsiderable feat
          of consulting the injury report before submitting a lineup, the Council doth hereby confer
          upon this manager the title of <span class="ceremony-title-inline">His Grace</span> —
          a fleeting glory of no monetary consequence, yet a burden of expectation henceforth.
        </div>
        <div class="ceremony-stats">
          <span><em>Scored</em><strong>${c.actual.toFixed(1)}</strong></span>
          <span><em>Efficiency</em><strong>${(c.efficiency * 100).toFixed(0)}%</strong></span>
          <span><em>Margin</em><strong>+${c.margin.toFixed(1)}</strong></span>
        </div>
        <div class="ceremony-seal">Sealed and stamped by the Council · Week ${roman(week)} · ${now.getFullYear()}</div>
        <div class="ceremony-scroll-bot">☙ ❧</div>
      </div>`;
  }

  function donkeyCardHtml(d, week, teams, playerName) {
    const t = teams.get(d.roster_id);
    const managerName = t?.display_name || t?.username || 'manager';
    const swap = d.swap;
    const priorOffenses = (donkeyCount.get(d.roster_id) || 1) - 1;
    return `
      <div class="punishment">
        <div class="punishment-preamble">HEAR YE · HEAR YE</div>
        <div class="punishment-title">THE DONKEY OF WEEK ${roman(week)}</div>
        <div class="punishment-name">${esc(teamName(d.roster_id))}</div>
        <div class="punishment-manager">Managed by ${esc(managerName)}${priorOffenses > 0 ? ` · Prior offenses: ${priorOffenses}` : ''}</div>
        <div class="punishment-body">
          ${swap ? `
            Let it be known throughout the land that this manager didst leave
            <em>${esc(playerName[swap.benched_id] || 'a bench player')}</em> and his <strong>${swap.benched_pts.toFixed(1)} points</strong> upon the bench,
            whilst starting the aptly-named <em>${esc(playerName[swap.starter_id] || 'a starter')}</em> for a meager ${swap.starter_pts.toFixed(1)}.
            A defeat of ${d.margin.toFixed(1)} points — a mistake worth <strong>${swap.gain.toFixed(1)}</strong> — brought about
            entirely by his own hand. Verily, thou art a <strong>dumbass</strong>.
          ` : `
            This manager didst lose by ${d.margin.toFixed(1)} points whilst leaving <strong>${d.missed.toFixed(1)}</strong> points
            upon the bench — a defeat brought about entirely by his own hand. Verily, thou art a <strong>dumbass</strong>.
          `}
        </div>
        <div class="punishment-stats">
          <span><em>Bench pts left</em><strong>${d.missed.toFixed(1)}</strong></span>
          <span><em>Scored</em><strong>${d.actual.toFixed(1)}</strong></span>
          <span><em>Optimal</em><strong>${d.optimal.toFixed(1)}</strong></span>
          <span><em>Lost by</em><strong>${d.margin.toFixed(1)}</strong></span>
        </div>
        <div class="punishment-seal">Recorded in the ledger of shame · Week ${roman(week)} · ${new Date().getFullYear()}</div>
      </div>`;
  }

  function lowestCardHtml(l, week) {
    const t = teams.get(l.roster_id);
    const managerName = t?.display_name || t?.username || 'manager';
    const priorCount = shameCount.get(l.roster_id) || 1;
    return `
      <div class="punishment">
        <div class="punishment-preamble">AND FURTHERMORE</div>
        <div class="punishment-title">THE PEASANT OF WEEK ${roman(week)}</div>
        <div class="punishment-name">${esc(teamName(l.roster_id))}</div>
        <div class="punishment-manager">Managed by ${esc(managerName)}${priorCount > 1 ? ` · Peasant appearances this season: ${priorCount}` : ''}</div>
        <div class="punishment-body">
          For scoring the meagerest sum of points in all the land — a paltry
          <strong>${l.points.toFixed(1)}</strong> — this manager is henceforth branded <em>The Peasant</em>,
          to till the fields of shame until such time as another produces a lower total.
          He shall pay <strong>$10</strong> to the treasury for his troubles, and go home to his hovel.
        </div>
        <div class="punishment-stats">
          <span><em>Total scored</em><strong>${l.points.toFixed(1)}</strong></span>
          <span><em>Penalty owed</em><strong>$10</strong></span>
          <span><em>Season count</em><strong>${priorCount}</strong></span>
        </div>
        <div class="punishment-seal">Recorded in the ledger of shame · Week ${roman(week)} · ${new Date().getFullYear()}</div>
      </div>`;
  }
}

window.Pages = {
  renderHome, renderMatchups, renderStandings, renderNews,
  renderTransactions, renderHistory,
  renderWire, renderTrending, renderInsiders,
  renderInjuries, renderInjuriesWidget,
  renderDraftKit, renderDues, renderTools, renderWaiver, renderShame,
};

})();
