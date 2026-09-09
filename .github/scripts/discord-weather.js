/**
 * NFL Weather Discord Poster
 *
 * Runs on a schedule (30 min game days, 60 min other days).
 * Fetches current week's NFL schedule, gets weather for each outdoor game
 * via Open-Meteo (free, no API key), formats a Discord embed, posts it.
 *
 * Env vars:
 *   DISCORD_WEATHER_WEBHOOK  — required
 *   FORCE_POST=true           — bypass dedupe (for manual triggers)
 *
 * State file: .github/data/weather-state.json — tracks last posted hash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STADIUMS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nfl-stadiums.json'), 'utf8'));
const STATE_FILE = path.join(REPO_ROOT, '.github', 'data', 'weather-state.json');
const WEBHOOK = process.env.DISCORD_WEATHER_WEBHOOK;
const FORCE_POST = process.env.FORCE_POST === 'true';

if (!WEBHOOK) {
  console.error('DISCORD_WEATHER_WEBHOOK not set');
  process.exit(1);
}

/* ─── Fetch NFL schedule (ESPN public API, no auth needed) ─── */
async function fetchNflSchedule() {
  // ESPN scoreboard endpoint - free, no key needed, gives current week
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard fetch failed: ${res.status}`);
  const data = await res.json();

  const week = data.week?.number || '?';
  const season = data.season?.year || new Date().getFullYear();

  const games = (data.events || []).map(event => {
    const comp = event.competitions?.[0];
    if (!comp) return null;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    return {
      id: event.id,
      date: event.date, // ISO
      homeAbbr: home.team.abbreviation,
      awayAbbr: away.team.abbreviation,
      homeName: home.team.displayName,
      awayName: away.team.displayName,
      status: event.status?.type?.name || 'STATUS_SCHEDULED',
    };
  }).filter(Boolean);

  return { week, season, games };
}

/* ─── Fetch weather from Open-Meteo for a specific time and location ─── */
async function fetchWeatherAtKickoff(lat, lng, kickoffISO) {
  const kickoff = new Date(kickoffISO);
  // Round down to nearest hour for hourly forecast lookup
  const hour = new Date(kickoff);
  hour.setMinutes(0, 0, 0);
  const dateStr = hour.toISOString().slice(0, 10);
  const hourStr = hour.toISOString().slice(0, 13);

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lng,
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    start_date: dateStr,
    end_date: dateStr,
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  const data = await res.json();

  const hourly = data.hourly;
  if (!hourly?.time) return null;

  // Find the closest hour to kickoff
  const kickoffUtcHour = hour.getUTCHours();
  // Open-Meteo returns times in local tz per timezone=auto
  let idx = hourly.time.findIndex(t => t.startsWith(hourStr));
  if (idx === -1) {
    // Fallback: find closest by time
    const kickoffMs = kickoff.getTime();
    let bestIdx = 0, bestDiff = Infinity;
    hourly.time.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - kickoffMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    });
    idx = bestIdx;
  }

  return {
    temp: Math.round(hourly.temperature_2m[idx]),
    precipProb: hourly.precipitation_probability[idx],
    precip: hourly.precipitation[idx],
    weatherCode: hourly.weather_code[idx],
    windSpeed: Math.round(hourly.wind_speed_10m[idx]),
    windDir: hourly.wind_direction_10m[idx],
  };
}

/* ─── Weather code interpretation (Open-Meteo WMO codes) ─── */
function weatherCodeToInfo(code) {
  const codes = {
    0: { emoji: '☀️', label: 'Clear' },
    1: { emoji: '🌤️', label: 'Mostly clear' },
    2: { emoji: '⛅', label: 'Partly cloudy' },
    3: { emoji: '☁️', label: 'Overcast' },
    45: { emoji: '🌫️', label: 'Fog' },
    48: { emoji: '🌫️', label: 'Fog' },
    51: { emoji: '🌦️', label: 'Light drizzle' },
    53: { emoji: '🌦️', label: 'Drizzle' },
    55: { emoji: '🌧️', label: 'Heavy drizzle' },
    61: { emoji: '🌧️', label: 'Light rain' },
    63: { emoji: '🌧️', label: 'Rain' },
    65: { emoji: '🌧️', label: 'Heavy rain' },
    71: { emoji: '🌨️', label: 'Light snow' },
    73: { emoji: '🌨️', label: 'Snow' },
    75: { emoji: '❄️', label: 'Heavy snow' },
    77: { emoji: '🌨️', label: 'Snow grains' },
    80: { emoji: '🌦️', label: 'Rain showers' },
    81: { emoji: '🌧️', label: 'Heavy showers' },
    82: { emoji: '⛈️', label: 'Violent showers' },
    85: { emoji: '🌨️', label: 'Snow showers' },
    86: { emoji: '❄️', label: 'Heavy snow showers' },
    95: { emoji: '⛈️', label: 'Thunderstorm' },
    96: { emoji: '⛈️', label: 'Thunderstorm w/ hail' },
    99: { emoji: '⛈️', label: 'Severe thunderstorm' },
  };
  return codes[code] || { emoji: '🌡️', label: 'Unknown' };
}

/* ─── Compass direction from degrees ─── */
function windDirection(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

/* ─── Classify game weather severity ─── */
function classifyWeather(weather) {
  if (!weather) return 'unknown';
  const { weatherCode, windSpeed, temp, precipProb } = weather;

  // Bad weather categories
  if (weatherCode >= 71) return 'bad'; // Snow of any kind
  if (weatherCode >= 61 && weatherCode <= 65) return 'bad'; // Real rain
  if (weatherCode >= 80 && weatherCode <= 82) return 'bad'; // Showers
  if (weatherCode >= 95) return 'bad'; // Thunderstorms
  if (windSpeed >= 20) return 'bad'; // High wind
  if (temp <= 25) return 'bad'; // Extreme cold
  if (temp >= 95) return 'bad'; // Extreme heat
  if (precipProb >= 60 && weatherCode >= 51) return 'bad'; // High precip probability with rain
  return 'clear';
}

/* ─── Format kickoff time for display ─── */
function formatKickoff(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short'
  });
  return `${day} ${time}`;
}

/* ─── Build Discord embed ─── */
function buildEmbed(week, season, gameResults) {
  const outdoorGames = gameResults.filter(g => !g.isDome);
  const indoorGames = gameResults.filter(g => g.isDome);

  const badGames = outdoorGames.filter(g => classifyWeather(g.weather) === 'bad');
  const clearGames = outdoorGames.filter(g => classifyWeather(g.weather) === 'clear');
  const unknownGames = outdoorGames.filter(g => classifyWeather(g.weather) === 'unknown');

  const formatGame = (g) => {
    if (!g.weather) return `• ${g.awayAbbr} @ ${g.homeAbbr} (${formatKickoff(g.date)}) — Weather unavailable`;
    const info = weatherCodeToInfo(g.weather.weatherCode);
    const wind = windDirection(g.weather.windDir);
    const precipNote = g.weather.precipProb >= 50 ? ` (${g.weather.precipProb}% precip)` : '';
    return `• **${g.awayAbbr} @ ${g.homeAbbr}** (${formatKickoff(g.date)}) — ${info.emoji} ${info.label}, ${g.weather.temp}°F, wind ${wind} ${g.weather.windSpeed} MPH${precipNote}`;
  };

  const fields = [];

  if (badGames.length) {
    fields.push({
      name: '🌧️ WEATHER CONCERNS',
      value: badGames.map(formatGame).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (clearGames.length) {
    fields.push({
      name: '☀️ CLEAR CONDITIONS',
      value: clearGames.map(formatGame).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (indoorGames.length) {
    const indoorText = indoorGames.map(g => {
      const stadium = STADIUMS[g.homeAbbr];
      return `• **${g.awayAbbr} @ ${g.homeAbbr}** (${formatKickoff(g.date)}) — ${stadium?.name || 'Indoor'}`;
    }).join('\n');
    fields.push({
      name: '🏟️ INDOOR (dome/retractable)',
      value: indoorText.slice(0, 1024),
      inline: false,
    });
  }

  if (unknownGames.length) {
    fields.push({
      name: '❓ WEATHER PENDING',
      value: unknownGames.map(g => `• ${g.awayAbbr} @ ${g.homeAbbr} (${formatKickoff(g.date)})`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  const now = new Date();
  const nowStr = now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  });

  return {
    embeds: [{
      title: `🏈 NFL WEATHER — Week ${week}`,
      description: `Updated ${nowStr}\n${gameResults.length} games this week`,
      color: 0x1E3A5F, // navy
      fields,
      footer: { text: '12guys1cup · Open-Meteo forecast · updates 30 min game days, 60 min other days' },
      timestamp: now.toISOString(),
    }],
  };
}

/* ─── Compute payload hash for dedupe ─── */
function payloadHash(payload) {
  const key = JSON.stringify(payload.embeds[0].fields);
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/* ─── Load / save state ─── */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ─── Post to Discord ─── */
async function postToDiscord(payload) {
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }
  console.log('✓ Posted to Discord');
}

/* ─── Main ─── */
async function main() {
  console.log('Fetching NFL schedule…');
  const { week, season, games } = await fetchNflSchedule();
  console.log(`Week ${week}, ${season} — ${games.length} games`);

  if (!games.length) {
    console.log('No games this week — skipping.');
    return;
  }

  // Fetch weather for each game
  const results = [];
  for (const game of games) {
    const stadium = STADIUMS[game.homeAbbr];
    if (!stadium) {
      console.log(`  ✗ ${game.awayAbbr} @ ${game.homeAbbr}: no stadium coords`);
      continue;
    }

    if (stadium.dome === 'fixed') {
      results.push({ ...game, isDome: true, weather: null });
      console.log(`  ~ ${game.awayAbbr} @ ${game.homeAbbr}: INDOOR`);
      continue;
    }

    try {
      // For retractable domes, still fetch weather (roof might be open)
      const weather = await fetchWeatherAtKickoff(stadium.lat, stadium.lng, game.date);
      results.push({ ...game, isDome: false, weather });
      console.log(`  ✓ ${game.awayAbbr} @ ${game.homeAbbr}: ${weather?.temp}°F ${weatherCodeToInfo(weather?.weatherCode).label}`);
    } catch (e) {
      console.log(`  ✗ ${game.awayAbbr} @ ${game.homeAbbr}: ${e.message}`);
      results.push({ ...game, isDome: false, weather: null });
    }

    // Rate limiting: Open-Meteo has generous limits but be polite
    await new Promise(r => setTimeout(r, 200));
  }

  const payload = buildEmbed(week, season, results);
  const hash = payloadHash(payload);

  const state = loadState();
  const stateKey = `week${week}_${season}`;

  if (!FORCE_POST && state[stateKey]?.hash === hash) {
    console.log(`No change since last post (hash ${hash}) — skipping.`);
    return;
  }

  await postToDiscord(payload);
  state[stateKey] = { hash, posted_at: new Date().toISOString() };
  saveState(state);
  console.log(`State saved. Hash: ${hash}`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
