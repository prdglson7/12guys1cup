/* =========================================================
   Config — edit this file to add/remove news sources.
   ========================================================= */

window.Config = {
  /* X (Twitter) accounts for the "Insiders" section.
     handle = the @username without the @  */
  X_HANDLES: [
    { handle: "AdamSchefter",  name: "Adam Schefter",  outlet: "ESPN" },
    { handle: "RapSheet",      name: "Ian Rapoport",   outlet: "NFL Network" },
    { handle: "TomPelissero",  name: "Tom Pelissero",  outlet: "NFL Network" },
    { handle: "Schultz_Report",name: "Jordan Schultz", outlet: "Fox Sports" },
    { handle: "DMRussini",     name: "Dianna Russini", outlet: "The Athletic" },
  ],

  /* Reddit disabled at the JS level — we fetch Reddit via RSS in the workflow
     instead (see RSS_FEEDS below). This stays empty. */
  REDDIT_SUBS: [],

  /* Server-side keyword filter for Reddit posts. Only posts whose title or
     summary contains one of these keywords (case-insensitive) make it into
     the wire. Keeps meme spam out. */
  INSIDER_KEYWORDS: [
    // Insiders
    "schefter", "rapoport", "rapsheet", "pelissero", "schultz",
    "russini", "glazer", "garafolo", "graziano", "fowler",
    "yates", "field yates", "anderson", "mortensen",
    // Breaking-news language
    "sources say", "per source", "per sources", "reports", "reporting",
    "breaking", "expected to sign", "expected to be released",
    // Transactions
    "traded", "trade", "signs", "signed", "signing", "released", "waived", "cut",
    "activated", "elevated", "designated",
    // Injuries
    "ruled out", "questionable", "doubtful", "injured reserve", " ir ",
    "torn", "acl", "mcl", "concussion", "high ankle", "hamstring",
    "will miss", "out for",
  ],

  /* RSS feeds pulled into "The Wire" (News page) via the server-side workflow.
     Everything else (PFT, RotoWire, RotoBaller, Reddit, insider tweets)
     is handled by Readybot.io Premium → Discord directly.

     Note: ESPN historically blocks GitHub Actions IPs with 403 errors.
     Included here anyway — if the workflow logs show 403 for ESPN, remove it. */
  RSS_FEEDS: [
    { tag: "PFF",   url: "https://www.pff.com/feed" },
    { tag: "ESPN",  url: "https://www.espn.com/espn/rss/nfl/news" },
  ],

  /* CORS proxy — allorigins is free and unlimited but occasionally slow.
     Alternative: 'https://corsproxy.io/?' */
  CORS_PROXY: "https://api.allorigins.win/get?url=",

  /* Sleeper trending: how many hours back and how many players to show */
  TRENDING_HOURS: 24,
  TRENDING_LIMIT: 25,

  /* Discord server integration — paste your server ID here after enabling widget.
     To find: Discord → Server Settings → Widget → Enable Widget → copy Server ID.
     Leave as null to hide the widget on the home page. */
  DISCORD_SERVER_ID: null,
  DISCORD_INVITE_URL: null,  // Optional: paste your permanent invite link (e.g. https://discord.gg/XXXX)
};
