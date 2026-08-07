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

  /* RSS feeds pulled into "The Wire" via the server-side workflow.
     type field: "rss" (default) or "espn-json".
     filterInsiders: true means only items matching INSIDER_KEYWORDS pass through.
     Note: ESPN blocks GitHub Actions IPs — we fetch ESPN client-side instead.
     Add/remove freely. If one is down it'll just be skipped.
     Duplicate items (same URL) across feeds are deduped by the workflow. */
  RSS_FEEDS: [
    { tag: "PFT",        url: "https://profootballtalk.nbcsports.com/feed/" },
    { tag: "ROTOWIRE",   url: "https://www.rotowire.com/rss/news.php?sport=NFL" },
    { tag: "PFF",        url: "https://www.pff.com/feed" },

    // RotoBaller — NFL-only category feeds. All tagged ROTOBALLER,
    // duplicates deduped by URL in the workflow.
    // The main /feed and /player-news/feed are all-sports (MLB, NBA, NHL,
    // MMA, UFC, PGA, NASCAR) so we don't use them.
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/category/nfl/feed" },
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/category/fantasy-football/feed" },
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/category/nfl-injury-news/feed" },
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/category/nfl-dfs/feed" },
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/category/nfl-player-news/feed" },

    // Reddit RSS with insider-keyword filter — free, catches insider tweet
    // reposts within 30-60 seconds of them dropping
    { tag: "R-NFL", url: "https://www.reddit.com/r/nfl/new/.rss", filterInsiders: true },
    { tag: "R-FF",  url: "https://www.reddit.com/r/fantasyfootball/new/.rss", filterInsiders: true },

    // Insider tweets via rss.app — uncomment after signing up if you go that route
    // { tag: "BREAKING",   url: "https://rss.app/feeds/YOUR_ID.xml" },
  ],

  /* CORS proxy — allorigins is free and unlimited but occasionally slow.
     Alternative: 'https://corsproxy.io/?' */
  CORS_PROXY: "https://api.allorigins.win/get?url=",

  /* Sleeper trending: how many hours back and how many players to show */
  TRENDING_HOURS: 24,
  TRENDING_LIMIT: 25,
};
