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

  /* Reddit disabled per user request. Set to [] to disable. */
  REDDIT_SUBS: [],
  INSIDER_KEYWORDS: [],

  /* RSS feeds pulled into "The Wire".
     type field: "rss" (default) or "espn-json" for ESPN's JSON API.
     Add/remove freely. If one is down it'll just be skipped.

     Insider feeds via rss.app go here too — see the docs for how to add. */
  RSS_FEEDS: [
    { tag: "PFT",        url: "https://profootballtalk.nbcsports.com/feed/" },
    { tag: "ROTOWIRE",   url: "https://www.rotowire.com/rss/news.php?sport=NFL" },
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/feed" },
    { tag: "PFF",        url: "https://www.pff.com/feed" },
    { tag: "ESPN",       url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=25", type: "espn-json" },

    // Insider tweets via rss.app — replace these URLs after signing up
    // and generating feeds for each insider. Free trial is 7 days, then $8/mo.
    // { tag: "SCHEFTER",   url: "https://rss.app/feeds/YOUR_ID.xml" },
    // { tag: "RAPOPORT",   url: "https://rss.app/feeds/YOUR_ID.xml" },
    // { tag: "PELISSERO",  url: "https://rss.app/feeds/YOUR_ID.xml" },
    // { tag: "SCHULTZ",    url: "https://rss.app/feeds/YOUR_ID.xml" },
    // { tag: "RUSSINI",    url: "https://rss.app/feeds/YOUR_ID.xml" },
  ],

  /* CORS proxy — allorigins is free and unlimited but occasionally slow.
     Alternative: 'https://corsproxy.io/?' */
  CORS_PROXY: "https://api.allorigins.win/get?url=",

  /* Sleeper trending: how many hours back and how many players to show */
  TRENDING_HOURS: 24,
  TRENDING_LIMIT: 25,
};
