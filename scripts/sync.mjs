#!/usr/bin/env node
/**
 * Sync script — pulls World Cup 2026 data from ESPN's free public API
 * (no auth required) and computes per-team stats. Writes data/stats.json.
 *
 * No env vars required. The legacy FOOTBALL_DATA_TOKEN secret is ignored.
 *
 * Endpoints used:
 *   GET /apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD
 *   GET /apis/v2/sports/soccer/fifa.world/standings?season=2026   (site.web.api host)
 *   GET /apis/site/v2/sports/soccer/fifa.world/summary?event={id}
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

const SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const WEB_BASE  = "https://site.web.api.espn.com/apis/v2/sports/soccer/fifa.world";
const TOURNAMENT_DATES = "20260611-20260719";
const SEASON = 2026;

const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
const draw   = JSON.parse(fs.readFileSync(path.join(dataDir, "draw.json"), "utf8"));
const prevStats = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, "stats.json"), "utf8")); }
  catch { return { teams: {}, manualOverrides: {} }; }
})();

// One-time wipe of legacy commish overrides — ESPN auto-tracks superstars now.
// Remove this line once you want the commish page's overrides to apply again.
prevStats.manualOverrides = {};

// ---- name mapping ----------------------------------------------------------
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
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

// ESPN-specific aliases we know about (so we don't have to touch config.json)
const ESPN_ALIASES = {
  "Türkiye":         ["Turkey", "Turkiye"],
  "Bosnia & Herz.":  ["Bosnia and Herzegovina", "Bosnia & Herzegovina", "Bosnia-Herzegovina", "Bosnia"],
  "DR Congo":        ["Congo DR", "DR Congo", "Democratic Republic of the Congo", "Congo"],
  "Ivory Coast":     ["Côte d'Ivoire", "Cote d'Ivoire", "Cote dIvoire"],
  "Cape Verde":      ["Cabo Verde"],
  "South Korea":     ["Korea Republic", "Korea Rep.", "Republic of Korea"],
  "Czechia":         ["Czech Republic"],
  "USA":             ["United States", "United States of America"],
  "Curaçao":         ["Curacao"]
};
for (const [canonical, aliases] of Object.entries(ESPN_ALIASES)) {
  if (!allTeams.has(canonical)) continue;
  for (const alias of aliases) nameMap[normalizeName(alias)] = canonical;
}

function mapTeam(apiName) {
  return nameMap[normalizeName(apiName)] || null;
}

// ---- HTTP ------------------------------------------------------------------
async function espnGet(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (wc-pool-sync)" }
  });
  if (res.status === 429) {
    console.log("Rate-limited; sleeping 10s and retrying...");
    await new Promise(r => setTimeout(r, 10_000));
    return espnGet(url);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN ${url} → ${res.status}: ${body.slice(0, 300)}`);
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

// Track which team names we have a Pot 2 superstar for (need detailed summary)
const pot2Teams = new Set();
for (const ts of Object.values(stats)) {
  if (ts.pot === 2 && ts.superstar) pot2Teams.add(ts.team);
}

// ---- stage mapping ---------------------------------------------------------
function mapStage(slug) {
  switch ((slug || "").toLowerCase()) {
    case "group-stage":     return "GROUP_STAGE";
    case "round-of-32":     return "ROUND_OF_32";
    case "round-of-16":     return "ROUND_OF_16";
    case "quarterfinals":   return "QUARTER_FINALS";
    case "semifinals":      return "SEMI_FINALS";
    case "3rd-place-match": return "THIRD_PLACE";
    case "final":           return "FINAL";
    default: return "";
  }
}

// ---- core sync -------------------------------------------------------------
async function main() {
  const notes = [];

  // 1) Scoreboard for the whole tournament window
  let sb;
  try {
    sb = await espnGet(`${SITE_BASE}/scoreboard?dates=${TOURNAMENT_DATES}&limit=200`);
  } catch (err) {
    writeStats("error", `Scoreboard fetch failed: ${err.message}`);
    return;
  }
  const events = sb.events || [];
  notes.push(`fetched ${events.length} events`);

  const finished = events.filter(e => e.status?.type?.state === "post");
  console.log(`Processing ${finished.length} finished events of ${events.length} total`);

  for (const e of finished) {
    await processMatch(e);
  }

  // 2) Standings (group finishes)
  try {
    const standings = await espnGet(`${WEB_BASE}/standings?season=${SEASON}`);
    processStandings(standings);
    notes.push("processed standings");
  } catch (err) {
    console.warn("Standings fetch failed (non-fatal):", err.message);
    notes.push(`standings failed: ${err.message}`);
  }

  // Anyone with any KO result has advanced
  for (const ts of Object.values(stats)) {
    if (ts.wonR32 || ts.wonR16 || ts.wonQF || ts.wonSF || ts.wonFinal || ts.wonThirdPlace || ts.lostFinal) {
      ts.advancedKO = true;
    }
  }

  // 3) Apply manual overrides (commish panel)
  // ESPN auto-tracks superstars now, so we ignore legacy overrides on this run.
  // The commish page can still add overrides going forward and they'll be applied.
  const overrides = prevStats.manualOverrides || {};
  for (const [team, fields] of Object.entries(overrides)) {
    if (!stats[team]) continue;
    for (const [k, v] of Object.entries(fields)) {
      stats[team][k] = v;
    }
  }

  writeStats("ok", `ESPN sync successful. ${notes.join("; ")}.`);
}

// summary cache so each event is fetched at most once per run
const summaryCache = new Map();
async function getSummary(eventId) {
  if (summaryCache.has(eventId)) return summaryCache.get(eventId);
  const j = await espnGet(`${SITE_BASE}/summary?event=${eventId}`);
  summaryCache.set(eventId, j);
  return j;
}

async function processMatch(e) {
  const comp = e.competitions?.[0];
  if (!comp) return;

  const competitors = comp.competitors || [];
  const homeC = competitors.find(c => c.homeAway === "home") || competitors[0];
  const awayC = competitors.find(c => c.homeAway === "away") || competitors[1];
  if (!homeC || !awayC) return;

  const homeName = mapTeam(homeC.team?.displayName) || mapTeam(homeC.team?.name) || mapTeam(homeC.team?.shortDisplayName);
  const awayName = mapTeam(awayC.team?.displayName) || mapTeam(awayC.team?.name) || mapTeam(awayC.team?.shortDisplayName);
  if (!homeName && !awayName) return;  // neither team is in our pool

  const homeScore = parseInt(homeC.score, 10) || 0;
  const awayScore = parseInt(awayC.score, 10) || 0;
  const stage = mapStage(e.season?.slug);

  // Winner (ESPN flips `winner` boolean even when decided by PKs)
  let winner = null;
  if (homeC.winner === true) winner = "home";
  else if (awayC.winner === true) winner = "away";
  else if (homeScore > awayScore) winner = "home";
  else if (awayScore > homeScore) winner = "away";

  // Detect PK shootout — ESPN sets status.type.name === "STATUS_FINAL_PEN" when decided by PKs
  const isKO = stage && stage !== "GROUP_STAGE";
  const compStatus = comp.status?.type || {};
  const wentToShootout = isKO && (
    compStatus.name === "STATUS_FINAL_PEN" ||
    /pen/i.test(compStatus.detail || "") ||
    /penalt/i.test(compStatus.description || "")
  );

  // Fetch summary only if we need superstar goal data (Pot 2 team in this match)
  const needSummary = pot2Teams.has(homeName) || pot2Teams.has(awayName);
  let summary = null;
  if (needSummary) {
    try {
      summary = await getSummary(e.id);
    } catch (err) {
      console.warn(`summary fetch failed for event ${e.id}:`, err.message);
    }
  }

  for (const side of ["home", "away"]) {
    const teamName = side === "home" ? homeName : awayName;
    if (!teamName || !stats[teamName]) continue;
    const ts = stats[teamName];

    const key = `${e.id}:${side}`;
    if (ts._matchesProcessed.includes(key)) continue;
    ts._matchesProcessed.push(key);

    const wonThis = winner === side;
    const oppScored = side === "home" ? awayScore : homeScore;

    if (oppScored === 0) ts.cleanSheets += 1;
    if (wentToShootout && wonThis) ts.pkWins += 1;
    // Underdog bonus: any Pot 3 win counts (group stage + KO)
    if (ts.pot === 3 && wonThis) ts.underdogWins += 1;

    if (wonThis) {
      if (stage === "ROUND_OF_32") ts.wonR32 = true;
      else if (stage === "ROUND_OF_16") ts.wonR16 = true;
      else if (stage === "QUARTER_FINALS") ts.wonQF = true;
      else if (stage === "SEMI_FINALS") ts.wonSF = true;
      else if (stage === "THIRD_PLACE") ts.wonThirdPlace = true;
      else if (stage === "FINAL") ts.wonFinal = true;
    } else if (stage === "FINAL") {
      ts.lostFinal = true;
    }

    // Superstar goals/assists for Pot 2
    if (ts.pot === 2 && ts.superstar && summary?.keyEvents) {
      for (const ev of summary.keyEvents) {
        // Only count regulation/ET goals, not shootout kicks
        if (!ev.scoringPlay) continue;
        if (ev.shootout === true) continue;
        const typeText = (ev.type?.text || "").toLowerCase();
        // Accept regular goals AND scored penalties; skip own goals, missed/saved penalties
        const isGoal = typeText.includes("goal") || /penalty\s*-\s*scored/.test(typeText);
        if (!isGoal) continue;
        if (typeText.includes("own")) continue;

        // Team association — ESPN's `team` here is a string (team name)
        const evTeamName = mapTeam(typeof ev.team === "string" ? ev.team : ev.team?.displayName);
        if (evTeamName !== teamName) continue;

        const scorer = ev.participants?.[0]?.athlete?.displayName
                    || ev.participants?.[0]?.athlete?.fullName
                    || ev.athletesInvolved?.[0]?.displayName;
        const assist = ev.participants?.[1]?.athlete?.displayName
                    || ev.participants?.[1]?.athlete?.fullName
                    || ev.athletesInvolved?.[1]?.displayName;

        if (namesMatch(scorer, ts.superstar)) ts.superstarGoals += 1;
        if (namesMatch(assist, ts.superstar)) ts.superstarAssists += 1;
      }
    }
  }
}

function processStandings(resp) {
  // Shape: { children: [ { name:"Group A", standings: { entries: [ { team, stats } ] } } ] }
  const children = resp.children || resp.standings?.children || [];
  for (const grp of children) {
    const entries = grp.standings?.entries || grp.entries || [];
    for (const entry of entries) {
      const teamName =
        mapTeam(entry.team?.displayName) ||
        mapTeam(entry.team?.name) ||
        mapTeam(entry.team?.shortDisplayName);
      if (!teamName || !stats[teamName]) continue;

      const statsArr = entry.stats || [];
      const getStat = (...names) => {
        for (const n of names) {
          const s = statsArr.find(x => x.name === n || x.shortDisplayName === n || x.type === n);
          if (s) return Number(s.value);
        }
        return null;
      };
      const rank   = getStat("rank", "P");
      const played = getStat("gamesPlayed", "GP") ?? 0;

      if (played >= 3 && rank && rank >= 1 && rank <= 4) {
        stats[teamName].groupFinish = rank;
      }
      if (stats[teamName].groupFinish === 1 || stats[teamName].groupFinish === 2) {
        stats[teamName].advancedKO = true;
      }
    }
  }
}

function namesMatch(apiName, configName) {
  if (!apiName || !configName) return false;
  const a = normalizeName(apiName);
  const b = normalizeName(configName);
  if (!a || !b) return false;
  if (a === b) return true;
  // last-name fallback: split original strings by whitespace
  const lastA = String(apiName).trim().split(/\s+/).pop();
  const lastB = String(configName).trim().split(/\s+/).pop();
  if (lastA && lastB && normalizeName(lastA) === normalizeName(lastB) &&
      Math.min(normalizeName(lastA).length, normalizeName(lastB).length) >= 4) {
    return true;
  }
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
  console.log(`stats.json written (${status}): ${message}`);
}

main().catch(err => {
  console.error("Sync failed:", err);
  writeStats("error", `Sync crashed: ${err.message}`);
  process.exit(1);
});
