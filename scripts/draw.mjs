#!/usr/bin/env node
/**
 * Generate (or regenerate) the draw.
 * Reads data/config.json, produces data/draw.json with random assignments.
 *
 * Usage:  npm run draw
 *         (or: node scripts/draw.mjs)
 *
 * Commit the resulting draw.json to freeze the assignments.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
const n = Math.min(
  config.players.length,
  config.pot1.length,
  config.pot2.length,
  config.pot3.length
);

const p1 = shuffle(config.pot1).slice(0, n);
const p2 = shuffle(config.pot2).slice(0, n);
const p3 = shuffle(config.pot3).slice(0, n);

const draw = {
  generatedAt: new Date().toISOString(),
  assignments: config.players.slice(0, n).map((player, i) => ({
    player,
    pot1: p1[i],
    pot2: p2[i].team,
    superstar: p2[i].superstar,
    pot3: p3[i]
  }))
};

fs.writeFileSync(path.join(dataDir, "draw.json"), JSON.stringify(draw, null, 2));
console.log(`✅ Draw written to data/draw.json (${n} players)`);
console.table(draw.assignments);
