/**
 * Live NFL Game Data Fetcher
 *
 * Pulls current week's game data from ESPN's public scoreboard API:
 *   - Opponent matchups
 *   - Vegas spreads and totals
 *   - Kickoff times
 *   - Weather (via Open-Meteo for outdoor games)
 *
 * Writes to assets/data/live-games.json which Start/Sit reads.
 *
 * Runs every 2 hours during game weeks — spreads move constantly,
 * and closer to kickoff = more accurate lines.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(REPO_ROOT, 'assets', 'data', 'live-games.json');
const STADIUMS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nfl-stadiums.json'), 'utf8'));

// ESPN team abbreviation mapping (they use different codes than Sleeper for a few teams)
const ESPN_TEAM_MAP = {
  'WSH': 'WAS',  // ESPN uses WSH for Washington
  'LA': 'LAR',   // ESPN sometimes uses LA for Rams
};

function normalizeTeam(abbr) {
  return ESPN_TEAM_MAP[abbr] || abbr;
}

/* Fetch ESPN scoreboard for current week */
async function fetchEspnScoreboard() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  return res.json();
}

/* Fetch Open-Meteo weather for a game */
async function fetchWeather(lat, lng, kickoffISO) {
  const kickoff = new Date(kickoffISO);
  const hour = new Date(kickoff);
  hour.setMinutes(0, 0, 0);
  const dateStr = hour.toISOString().slice(0, 10);
  const hourStr = hour.toISOString().slice(0, 13);

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lng,
    hourly: 'temperature_2m,precipitation,weather_code,wind_speed_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    start_date: dateStr,
    end_date: dateStr,
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();

  const hourly = data.hourly;
  if (!hourly?.time) return null;

  let idx = hourly.time.findIndex(t => t.startsWith(hourStr));
  if (idx === -1) {
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
    precip: hourly.precipitation[idx],
    weatherCode: hourly.weather_code[idx],
    wind: Math.round(hourly.wind_speed_10m[idx]),
  };
}

/* Parse ESPN game odds — returns { spread, total, favorite } */
function parseOdds(competition) {
  const odds = competition?.odds?.[0];
  if (!odds) return { spread: null, total: null, favorite: null };

  // ESPN provides: details (e.g. "PHI -6.5"), overUnder, homeTeamOdds, awayTeamOdds
  const total = odds.overUnder != null ? Number(odds.overUnder) : null;

  // Spread from homeTeamOdds/awayTeamOdds — favored team has negative spread
  let spread = null;
  let favoriteAbbr = null;
  if (odds.homeTeamOdds?.spread != null) {
    spread = Number(odds.homeTeamOdds.spread);
    // Positive spread means home is underdog; negative means home is favorite
    favoriteAbbr = spread < 0 ? 'home' : (spread > 0 ? 'away' : 'pick');
  } else if (odds.details) {
    // Parse from details string as fallback: "PHI -6.5" or "PHI -6.5 -110"
    const match = odds.details.match(/([A-Z]{2,4})\s*(-?\d+(?:\.\d+)?)/);
    if (match) {
      favoriteAbbr = normalizeTeam(match[1]);
      spread = Number(match[2]); // negative from the favorite's perspective
    }
  }

  return { spread, total, favorite: favoriteAbbr };
}

/* Main */
async function main() {
  console.log('Fetching ESPN scoreboard…');
  const scoreboard = await fetchEspnScoreboard();
  const week = scoreboard.week?.number || null;
  const season = scoreboard.season?.year || new Date().getFullYear();
  console.log(`Week ${week}, ${season}`);

  const events = scoreboard.events || [];
  console.log(`${events.length} games this week`);

  const teamGames = {}; // { teamAbbr: { week: gameData } }

  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const homeAbbr = normalizeTeam(home.team.abbreviation);
    const awayAbbr = normalizeTeam(away.team.abbreviation);
    const stadium = STADIUMS[homeAbbr];
    const kickoff = event.date;

    // Parse odds
    const { spread, total, favorite } = parseOdds(comp);
    // Compute team-specific spread: positive means this team is favored
    // ESPN spread is from home team perspective (negative = home favored)
    let homeSpread = null, awaySpread = null;
    if (spread != null) {
      // If ESPN gave us a home-perspective spread
      if (favorite === 'home' || favorite === 'away' || favorite === 'pick') {
        homeSpread = spread;      // negative = home favored
        awaySpread = -spread;
      } else if (favorite === homeAbbr) {
        homeSpread = -Math.abs(spread);
        awaySpread = Math.abs(spread);
      } else if (favorite === awayAbbr) {
        homeSpread = Math.abs(spread);
        awaySpread = -Math.abs(spread);
      } else {
        homeSpread = spread;
        awaySpread = -spread;
      }
    }

    // Convert to "team favored" convention: positive = this team is favored
    const homeSpreadFav = homeSpread != null ? -homeSpread : null;
    const awaySpreadFav = awaySpread != null ? -awaySpread : null;

    // Roof and weather
    let roof = stadium?.dome === 'fixed' ? 'dome' :
               stadium?.dome === 'retractable' ? 'closed' : // assume closed if retractable
               'outdoors';
    let weatherData = null;

    if (roof === 'outdoors' && stadium) {
      try {
        weatherData = await fetchWeather(stadium.lat, stadium.lng, kickoff);
        console.log(`  ✓ ${awayAbbr} @ ${homeAbbr}: ${weatherData?.temp}°F wind ${weatherData?.wind}mph`);
      } catch (e) {
        console.log(`  ✗ ${awayAbbr} @ ${homeAbbr} weather: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    } else {
      console.log(`  ~ ${awayAbbr} @ ${homeAbbr}: ${roof.toUpperCase()}`);
    }

    // Build game context for both teams
    const homeCtx = {
      opp: awayAbbr,
      home: true,
      spread: homeSpreadFav,
      total: total,
      roof: roof,
      temp: weatherData?.temp || null,
      wind: weatherData?.wind || null,
      precip: weatherData?.precip || null,
      kickoff: kickoff,
    };
    const awayCtx = {
      opp: homeAbbr,
      home: false,
      spread: awaySpreadFav,
      total: total,
      roof: roof,
      temp: weatherData?.temp || null,
      wind: weatherData?.wind || null,
      precip: weatherData?.precip || null,
      kickoff: kickoff,
    };

    if (!teamGames[homeAbbr]) teamGames[homeAbbr] = {};
    if (!teamGames[awayAbbr]) teamGames[awayAbbr] = {};
    teamGames[homeAbbr][String(week)] = homeCtx;
    teamGames[awayAbbr][String(week)] = awayCtx;
  }

  const output = {
    fetched_at: new Date().toISOString(),
    season: season,
    week: week,
    game_count: events.length,
    teams: teamGames,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Teams with game data: ${Object.keys(teamGames).length}`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
