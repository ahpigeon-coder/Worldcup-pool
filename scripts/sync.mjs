#!/usr/bin/env node
/**
 * Sync script — pulls World Cup 2026 data from football-data.org
 * and computes per-team stats. Writes data/stats.json.
 *
 * Required env vars:
 *   FOOTBALL_DATA_TOKEN — your free API token from https://www.football-data.org/client/register
 *                        (store as a GitHub Secret named FOOTBALL_DATA_TOKEN)
 *
 * Run via:
 *   npm run sync
 *   or:  FOOTBALL_DATA_TOKEN=xxx node scripts/sync.mjs
 *
 * Safe to run before the tournament starts — it will simply write a
 * stats.json reflecting "no matches yet" and exit cleanly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_BASE = "https://api.football-data.org/v4";
// football-data.org competition code for FIFA World Cup
const COMPETITION = "WC";
const SEASON = 2026;

const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
const draw = JSON.parse(fs.readFileSync(path.join(dataDir, "draw.json"), "utf8"));
const prevStats = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, "stats.json"), "utf8")); }
  catch { return { teams: {}, manualOverrides: {} }; }
})();

// ---- name mapping ----------------------------------------------------------
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

const nameMap = {};
const allTeams = new Set();
for (const t of config.pot1) allTeams.add(t);
for (const t of config.pot2) allTeams.add(t.team);
for (const t of config.pot3) allTeams.add(t);

for (const canonical of allTeams) {
  nameMap[normalizeName(canonical)] = canonical;
  const aliases = config.apiFootballNameAliases?.[canonical] || [];
  for (const alias of aliases) nameMap[normalizeName(alias)] = canonical;
}

function mapTeam(apiName) {
  return nameMap[normalizeName(apiName)] || null;
}

// ---- HTTP ------------------------------------------------------------------
async function apiGet(endpoint) {
  if (!TOKEN) throw new Error("Missing FOOTBALL_DATA_TOKEN env var");
  const url = API_BASE + endpoint;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": TOKEN }
  });
  if (res.status === 429) {
    // rate limited — back off 70s and retry once
    console.log("Rate-limited; sleeping 70s and retrying...");
    await new Promise(r => setTimeout(r, 70_000));
    return apiGet(endpoint);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${endpoint} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.json();
}

// ---- team stat init --------------------------------------------------------
function blankTeamStat(potNumber, teamName, superstarName) {
  return {
    team: teamName,
    pot: potNumber,
    superstar: superstarName || null,
    groupFinish: 0,
    advancedKO: false,
    wonR32: false,
    wonR16: false,
    wonQF: false,
    wonSF: false,
    wonFinal: false,
    wonThirdPlace: false,
    lostFinal: false,
    cleanSheets: 0,
    pkWins: 0,
    underdogWins: 0,
    superstarGoals: 0,
    superstarAssists: 0,
    _matchesProcessed: []
  };
}

const stats = {};
for (const a of draw.assignments) {
  stats[a.pot1] = blankTeamStat(1, a.pot1, null);
  stats[a.pot2] = blankTeamStat(2, a.pot2, a.superstar);
  stats[a.pot3] = blankTeamStat(3, a.pot3, null);
}

// ---- core sync -------------------------------------------------------------
// Cache so we only fetch /matches/{id} once per fixture
const matchDetailCache = new Map();

async function main() {
  const notes = [];

  if (!TOKEN) {
    console.log("⚠️  No FOOTBALL_DATA_TOKEN set — writing placeholder stats.json.");
    writeStats("no-api-key", "FOOTBALL_DATA_TOKEN not configured. Add it to GitHub Secrets to enable live sync.");
    return;
  }

  // --- matches ---
  let matchesResp;
  try {
    matchesResp = await apiGet(`/competitions/${COMPETITION}/matches?season=${SEASON}`);
    notes.push(`fetched ${matchesResp.matches?.length || 0} matches`);
  } catch (err) {
    console.error("Matches fetch failed:", err.message);
    writeStats("error", `Matches fetch failed: ${err.message}`);
    return;
  }

  const matches = matchesResp.matches || [];
  if (matches.length === 0) {
    writeStats("no-matches", `No matches found for WC ${SEASON} yet. Check again after the fixtures are published.`);
    return;
  }

  // Process each finished match
  const finished = matches.filter(m => m.status === "FINISHED");
  console.log(`Processing ${finished.length} finished matches (of ${matches.length} total)`);

  for (const m of finished) {
    await processMatch(m);
  }

  // --- standings (for group finish) ---
  try {
    const standingsResp = await apiGet(`/competitions/${COMPETITION}/standings?season=${SEASON}`);
    processStandings(standingsResp);
    notes.push(`processed standings`);
  } catch (err) {
    console.warn("Standings fetch failed (non-fatal):", err.message);
    notes.push(`standings failed: ${err.message}`);
  }

  // --- apply manual overrides ---
  const overrides = prevStats.manualOverrides || {};
  for (const [team, fields] of Object.entries(overrides)) {
    if (!stats[team]) continue;
    for (const [k, v] of Object.entries(fields)) {
      stats[team][k] = v;
    }
  }

  writeStats("ok", `Sync successful. ${notes.join("; ")}.`);
}

async function processMatch(m) {
  const home = mapTeam(m.homeTeam?.name);
  const away = mapTeam(m.awayTeam?.name);
  if (!home && !away) return;

  const stage = (m.stage || "").toUpperCase();        // e.g. GROUP_STAGE, LAST_16, QUARTER_FINALS, SEMI_FINALS, FINAL, THIRD_PLACE
  const group = (m.group || "").toUpperCase();

  const fullHome = m.score?.fullTime?.home ?? 0;
  const fullAway = m.score?.fullTime?.away ?? 0;
  const penHome = m.score?.penalties?.home;
  const penAway = m.score?.penalties?.away;
  const wentToShootout = penHome != null && penAway != null;

  let winner = null;
  if (wentToShootout) {
    winner = penHome > penAway ? "home" : "away";
  } else if (m.score?.winner === "HOME_TEAM") winner = "home";
  else if (m.score?.winner === "AWAY_TEAM") winner = "away";
  else if (fullHome > fullAway) winner = "home";
  else if (fullAway > fullHome) winner = "away";

  for (const side of ["home", "away"]) {
    const teamName = side === "home" ? home : away;
    if (!teamName || !stats[teamName]) continue;
    const ts = stats[teamName];

    const key = `${m.id}:${side}`;
    if (ts._matchesProcessed.includes(key)) continue;
    ts._matchesProcessed.push(key);

    const wonThis = winner === side;
    const oppScored = side === "home" ? fullAway : fullHome;

    if (oppScored === 0) ts.cleanSheets += 1;
    if (wentToShootout && wonThis) ts.pkWins += 1;
    if (ts.pot === 3 && wonThis) ts.underdogWins += 1;

    // Round mapping
    if (wonThis) {
      if (stage === "ROUND_OF_32" || stage === "LAST_32") ts.wonR32 = true;
      else if (stage === "ROUND_OF_16" || stage === "LAST_16") ts.wonR16 = true;
      else if (stage === "QUARTER_FINALS") ts.wonQF = true;
      else if (stage === "SEMI_FINALS") ts.wonSF = true;
      else if (stage === "THIRD_PLACE" || stage === "3RD_PLACE_FINAL" || stage === "THIRD_PLACE_FINAL") ts.wonThirdPlace = true;
      else if (stage === "FINAL") ts.wonFinal = true;
    } else {
      if (stage === "FINAL") ts.lostFinal = true;
    }

    // Superstar goals/assists (Pot 2 only)
    // football-data.org match summary doesn't include goalscorers — must fetch /matches/{id}
    if (ts.pot === 2 && ts.superstar) {
      try {
        if (!matchDetailCache.has(m.id)) {
          matchDetailCache.set(m.id, await apiGet(`/matches/${m.id}`));
        }
        const detail = matchDetailCache.get(m.id);
        const goals = detail.goals || [];
        for (const g of goals) {
          const scorerTeamName = g.team?.name;
          if (scorerTeamName && mapTeam(scorerTeamName) !== teamName) continue;
          if (namesMatch(g.scorer?.name, ts.superstar)) {
            if ((g.type || "").toUpperCase() !== "OWN") ts.superstarGoals += 1;
          }
          if (namesMatch(g.assist?.name, ts.superstar)) {
            ts.superstarAssists += 1;
          }
        }
      } catch (err) {
        console.warn(`Match detail fetch failed for ${m.id}:`, err.message);
      }
    }
  }
}

function processStandings(resp) {
  const standings = resp.standings || [];
  for (const grp of standings) {
    // type is usually "TOTAL" — we care about table rows
    if (grp.type && grp.type !== "TOTAL") continue;
    const table = grp.table || [];
    for (const row of table) {
      const team = mapTeam(row.team?.name);
      if (!team || !stats[team]) continue;
      const played = row.playedGames ?? 0;
      if (played >= 3) {
        const pos = Number(row.position) || 0;
        if (pos >= 1 && pos <= 4) stats[team].groupFinish = pos;
      }
      if (stats[team].groupFinish === 1 || stats[team].groupFinish === 2) {
        stats[team].advancedKO = true;
      }
    }
  }
  // Anyone who has a KO result advanced
  for (const ts of Object.values(stats)) {
    if (ts.wonR32 || ts.wonR16 || ts.wonQF || ts.wonSF || ts.wonFinal || ts.wonThirdPlace || ts.lostFinal) {
      ts.advancedKO = true;
    }
  }
}

function namesMatch(apiName, configName) {
  if (!apiName || !configName) return false;
  const a = normalizeName(apiName);
  const b = normalizeName(configName);
  if (a === b) return true;
  const lastA = a.split(/\s+/).pop();
  const lastB = b.split(/\s+/).pop();
  if (lastA && lastB && lastA === lastB && Math.min(a.length, b.length) >= 4) return true;
  return false;
}

function writeStats(status, message) {
  const out = {};
  for (const [k, v] of Object.entries(stats)) {
    const { _matchesProcessed, ...clean } = v;
    out[k] = clean;
  }
  const final = {
    lastSynced: new Date().toISOString(),
    lastSyncStatus: status,
    lastSyncMessage: message,
    teams: out,
    manualOverrides: prevStats.manualOverrides || {}
  };
  fs.writeFileSync(path.join(dataDir, "stats.json"), JSON.stringify(final, null, 2));
  console.log(`✅ stats.json written (${status}): ${message}`);
}

main().catch(err => {
  console.error("Sync failed:", err);
  writeStats("error", `Sync crashed: ${err.message}`);
  process.exit(1);
});

