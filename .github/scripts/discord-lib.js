/**
 * Shared helpers for posting to Discord webhooks.
 * All 4 workflow scripts (news, injuries, scores, recap) use these.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_AVATAR = 'https://prdglson7.github.io/12guys1cup/assets/img/logo.jpg';
const BOT_NAME   = '12guys1cup Bot';

// Site color palette (as hex integers, Discord's format)
const COLORS = {
  gold: 0xE8B84A,
  red:  0xC8352E,
  navy: 0x1E3A5F,
  green: 0x2E7D32,
};

/**
 * POST a message to a Discord webhook.
 * `embeds` is an array of Discord embed objects (title, description, color, url, etc.)
 */
function postToDiscord(webhookUrl, { content = '', embeds = [] } = {}) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl) {
      return reject(new Error('Webhook URL missing.'));
    }
    const body = JSON.stringify({
      username: BOT_NAME,
      avatar_url: BOT_AVATAR,
      content,
      embeds,
      // Suppress @everyone/@here mentions even if content contains them
      allowed_mentions: { parse: [] },
    });

    const u = new URL(webhookUrl);
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(new Error(`Discord ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Discord webhook timeout')));
    req.write(body);
    req.end();
  });
}

/** Sleep helper — respect Discord rate limits (30 req/min per channel). */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Load state file — returns empty object if file doesn't exist. */
function loadState(statePath = 'assets/data/discord-state.json') {
  try {
    if (!fs.existsSync(statePath)) return {};
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    console.log(`State file unreadable, starting fresh: ${e.message}`);
    return {};
  }
}

/** Write state file (create dir if needed). */
function saveState(state, statePath = 'assets/data/discord-state.json') {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** Check if we're currently in the NFL regular season (Sept–early Feb). */
function isInSeason(now = new Date()) {
  const month = now.getUTCMonth() + 1;  // 1–12
  return month >= 9 || month <= 2;
}

module.exports = {
  postToDiscord,
  sleep,
  loadState,
  saveState,
  isInSeason,
  COLORS,
  BOT_NAME,
  BOT_AVATAR,
};
