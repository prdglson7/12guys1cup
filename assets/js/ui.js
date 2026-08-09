/* =========================================================
   Shared UI: header/nav injection + helpers
   ========================================================= */

const NAV = [
  { href: "index.html",        label: "Home" },
  { href: "matchups.html",     label: "Matchups" },
  { href: "standings.html",    label: "Standings" },
  { href: "dues.html",         label: "Dues" },
  { href: "draft-kit.html",    label: "Draft Kit" },
  { href: "tools.html",        label: "Tools" },
  { href: "waiver.html",       label: "Waivers" },
  { href: "injuries.html",     label: "Injuries" },
  { href: "news.html",         label: "News" },
  { href: "transactions.html", label: "Moves" },
  { href: "history.html",      label: "History" },
];

function renderChrome(activePage) {
  const header = document.getElementById("site-header");
  const nav = document.getElementById("site-nav");
  const footer = document.getElementById("site-footer");

  if (header) header.innerHTML = `
    <div class="wrap brandbar">
      <img src="assets/img/logo.jpg" alt="12 Guys 1 Cup logo" class="logo">
      <div>
        <div class="wordmark">12GUYS1CUP</div>
        <div class="tagline">Fantasy football • Since kickoff</div>
      </div>
    </div>`;

  if (nav) nav.innerHTML = `
    <div class="wrap">
      <ul>
        ${NAV.map(n => `<li><a href="${n.href}" ${n.href === activePage ? 'class="active"' : ''}>${n.label}</a></li>`).join("")}
      </ul>
    </div>`;

  if (footer) footer.innerHTML = `
    <div class="wrap">
      12 GUYS 1 CUP • Powered by <a href="https://sleeper.com" target="_blank" rel="noopener">Sleeper</a>
      &amp; <a href="https://www.espn.com/nfl" target="_blank" rel="noopener">ESPN</a>
    </div>`;

  // Scroll-to-top button — appears after scrolling 400px, smooth-scrolls on click
  if (!document.getElementById("scroll-top-btn")) {
    const btn = document.createElement("button");
    btn.id = "scroll-top-btn";
    btn.className = "scroll-top-btn";
    btn.setAttribute("aria-label", "Scroll to top");
    btn.innerHTML = "▲";
    btn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.body.appendChild(btn);

    const onScroll = () => {
      btn.classList.toggle("visible", window.scrollY > 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
}

/* State helpers */
const loading = (msg="Loading…") =>
  `<div class="state"><span class="spinner"></span>${msg}</div>`;
const empty = (msg="Nothing here yet.") =>
  `<div class="state">${msg}</div>`;
const errBox = (msg) =>
  `<div class="state error">⚠ ${msg}</div>`;

/* Escape HTML for safe insertion */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Format numbers */
const fmt1 = n => (Number(n) || 0).toFixed(1);
const fmt2 = n => (Number(n) || 0).toFixed(2);

/* Relative time (short) */
function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60)     return "just now";
  if (s < 3600)   return `${Math.floor(s/60)}m ago`;
  if (s < 86400)  return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString();
}

/* Fallback avatar */
function avatarUrl(team) {
  if (team && team.avatar) return team.avatar;
  return "assets/img/logo.jpg";
}

window.UI = { renderChrome, loading, empty, errBox, esc, fmt1, fmt2, relTime, avatarUrl };
