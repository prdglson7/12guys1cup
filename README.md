# 12 Guys 1 Cup — Fantasy Football HQ

A static site for your Sleeper fantasy league. Live scores, standings, power rankings, NFL news, transactions, and history — all pulled from public APIs, no backend needed.

## What's in here

```
12guys1cup/
├── index.html          # Home
├── matchups.html       # Weekly matchups
├── standings.html      # Standings + power rankings
├── news.html           # NFL news (ESPN)
├── transactions.html   # Waivers & trades
├── history.html        # Records + past champs
├── .nojekyll           # Tells GitHub Pages to skip Jekyll
└── assets/
    ├── css/styles.css
    ├── js/
    │   ├── sleeper.js  # Sleeper API client
    │   ├── news.js     # ESPN news
    │   ├── ui.js       # Shared UI
    │   └── pages.js    # Page renderers
    └── img/logo.jpg    # Your league logo
```

## Deploy to GitHub Pages

1. Create a new GitHub repo — anything like `12guys1cup`.
2. Drop the contents of this folder into the repo root (not the `12guys1cup` folder itself — its contents).
3. Commit and push.
4. In the repo → **Settings → Pages** → set source to **`main` / root** and save.
5. In a minute or two, it'll be live at `https://<your-username>.github.io/12guys1cup/`.

## What's connected

- **Sleeper API** — no key, no login. League ID `1389753693590532096` is hardcoded in `assets/js/sleeper.js` (change it there if you ever swap leagues).
- **Sleeper trending players** — free, no key. Shows most-added players in the last 24 hours across every Sleeper league — great leading indicator of breaking news.
- **ESPN news** — public JSON endpoint, no key.
- **The Wire (RSS aggregation)** — PFT, RotoWire, CBS Sports, Yahoo, NFL.com. Configured in `assets/js/config.js`. Uses `allorigins.win` as a free CORS proxy. Add/remove feeds by editing that config file.
- **The Insiders (X embeds)** — Schefter, Rapoport, Pelissero, Schultz, Russini. Configured in `assets/js/config.js`. Uses X's official widget script.

## Editing news sources

All in `assets/js/config.js`. Edit the file, commit, push — changes go live in ~30 seconds.

- To add an X insider: append `{ handle: "username", name: "Full Name", outlet: "Employer" }` to `X_HANDLES`
- To add an RSS feed: append `{ tag: "SHORT", url: "https://..." }` to `RSS_FEEDS` — the `tag` shows in the source pill on each headline
- To change trending window: edit `TRENDING_HOURS` (default 24)

## Caveats on speed

- **X embeds are ~80% reliable** as of 2026 — sometimes they show blank tiles when X's widget script hiccups. There's a fallback link to open the profile directly on X when that happens. There's no fix; it's an X-side issue.
- **The Wire depends on `allorigins.win`** being up. If it goes down, wire items won't load but every other section still works. You can swap to a different proxy by editing `CORS_PROXY` in `config.js` (e.g. `https://corsproxy.io/?`).
- **Sleeper trending is the most reliable fast signal** — no proxy needed, no key, always works.

## Notes on data

- Player database (~5MB from Sleeper) is cached in your browser's localStorage for 24 hours after first load. Refreshing pages after that is fast.
- Power rankings are computed client-side: 60% win rate + 25% points-for percentile + 15% recent form (last 3 weeks vs. season average).
- The "League players only" filter on the News page kicks in a second or two after page load, once the player database finishes downloading.

## Planned for v2

- AI-generated weekly recaps and trash talk (currently skipped per your call — needs a serverless function or GitHub Action to safely hold an API key).
- Head-to-head all-time records between owners.
- Playoff bracket view.

## Troubleshooting

- **Nothing loads** → Check the browser console. Sleeper API is public and CORS-safe; if you see a network error, it's likely just Sleeper rate-limiting a burst of requests. Wait a minute and refresh.
- **News page empty** → ESPN sometimes returns a 4xx if their edge is being fussy. It'll come back on its own.
- **History page says no seasons on record** → That's expected for a brand new league. Past champions show up once the league completes its first title.
