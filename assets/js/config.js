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
     Add/remove freely. If one is down it'll just be skipped.

     The last block uses RSSHub (a free public service that scrapes X/Twitter
     profiles and produces RSS). It's occasionally rate-limited or down —
     when it works, you get insider tweets live in your Wire. When it
     doesn't, the section is silently skipped. Zero downside to trying. */
  RSS_FEEDS: [
    { tag: "PFT",        url: "https://profootballtalk.nbcsports.com/feed/" },
    { tag: "ROTOWIRE",   url: "https://www.rotowire.com/rss/news.php?sport=NFL" },
    { tag: "ROTOBALLER", url: "https://www.rotoballer.com/feed" },
    { tag: "NFLCOM",     url: "https://www.nfl.com/feeds/rss/news" },
    { tag: "ESPN",       url: "https://www.espn.com/espn/rss/nfl/news" },
    { tag: "PFF",        url: "https://www.pff.com/feed" },

    // Insider tweets via RSSHub — may not always work but worth trying
    { tag: "SCHEFTER",   url: "https://rsshub.app/twitter/user/AdamSchefter" },
    { tag: "RAPOPORT",   url: "https://rsshub.app/twitter/user/RapSheet" },
    { tag: "PELISSERO",  url: "https://rsshub.app/twitter/user/TomPelissero" },
    { tag: "SCHULTZ",    url: "https://rsshub.app/twitter/user/Schultz_Report" },
    { tag: "RUSSINI",    url: "https://rsshub.app/twitter/user/DMRussini" },
  ],

  /* CORS proxy — allorigins is free and unlimited but occasionally slow.
     Alternative: 'https://corsproxy.io/?' */
  CORS_PROXY: "https://api.allorigins.win/get?url=",

  /* Sleeper trending: how many hours back and how many players to show */
  TRENDING_HOURS: 24,
  TRENDING_LIMIT: 25,
};
