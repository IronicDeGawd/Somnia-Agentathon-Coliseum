/**
 * rescore-persona-bakeoff.ts
 * --------------------------
 * Re-scores a completed persona bake-off from the probe's stored answers, with
 * no new inferences and no new spend.
 *
 * The first scoring pass was wrong. Each persona's "character" rule asserted a
 * preferred action without checking that action was in the allowed set, so
 * The Quant and The Contrarian were marked down for not buying a dip in
 * scenarios where BuySOMI was not offered at all — one of which allowed only
 * Hold. Those are impossible expectations, not persona failures.
 *
 * A character rule may only judge a turn where the preferred action was
 * actually available. Everything else returns null and is excluded.
 *
 * Run:
 *   PROBE_ADDRESS=0x.. pnpm exec hardhat run scripts/rescore-persona-bakeoff.ts --network somnia
 */
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { PERSONA_NAMES } from "./personas";

interface Scenario { key: string; move: string; holds: boolean; allowed: string[] }

const SCENARIOS: Scenario[] = [
  { key: "S1-nobase-flat",  move: "is flat",          holds: false, allowed: ["Hold", "BuySOMI"] },
  { key: "S2-holds-up",     move: "is up slightly",   holds: true,  allowed: ["Hold", "BuySOMI", "SellSOMI"] },
  { key: "S3-holds-nocash", move: "is down slightly", holds: true,  allowed: ["Hold", "SellSOMI"] },
  { key: "S4-empty-broke",  move: "is down",          holds: false, allowed: ["Hold"] },
  { key: "S5-opening",      move: "has just opened, with no move to read yet", holds: false, allowed: ["Hold", "BuySOMI"] },
  { key: "S6-big-dip",      move: "is down sharply",  holds: false, allowed: ["Hold", "BuySOMI"] },
];

/** Only judge when the persona's preferred action was actually on the menu. */
const CHARACTER: Record<string, (a: string, s: Scenario) => boolean | null> = {
  // "Trade whenever you can" — untestable when Hold is the only option.
  "The Degen":   (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Whale":   (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Scalper": (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  // Mean reversion: buy weakness, sell strength, hold when flat — each judged
  // only when the action it calls for is available.
  "The Quant": (a, s) => {
    if (s.move === "is flat") return a === "Hold";
    if (s.move.includes("down")) return s.allowed.includes("BuySOMI") ? a === "BuySOMI" : null;
    if (s.move.includes("up") && s.holds) return s.allowed.includes("SellSOMI") ? a === "SellSOMI" : null;
    return null;
  },
  "The Contrarian": (a, s) => {
    if (s.move === "is flat") return a === "Hold";
    if (s.move.includes("down")) return s.allowed.includes("BuySOMI") ? a === "BuySOMI" : null;
    if (s.move.includes("up")) return s.allowed.includes("SellSOMI") ? a === "SellSOMI" : null;
    return null;
  },
  // Never sells, under any circumstance — always testable.
  "The Diamond Hand": (a) => !a.startsWith("Sell"),
};

async function main() {
  const pub = await hre.viem.getPublicClient();
  const probe = process.env.PROBE_ADDRESS as `0x${string}`;
  if (!probe) throw new Error("set PROBE_ADDRESS");
  const art = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "artifacts/contracts/PromptProbe.sol/PromptProbe.json"), "utf8"),
  );

  const answers = new Map<string, string>();
  const n = (await pub.readContract({ address: probe, abi: art.abi, functionName: "probeCount" })) as bigint;
  for (let i = 0n; i < n; i++) {
    const id = (await pub.readContract({ address: probe, abi: art.abi, functionName: "requestIds", args: [i] })) as bigint;
    const r = (await pub.readContract({ address: probe, abi: art.abi, functionName: "getProbe", args: [id] })) as unknown[];
    const [label, , answered, , , , , asStr] = r as [string, boolean, boolean, number, bigint, string, bigint, string];
    if (answered && label.startsWith("PB|")) answers.set(label, (asStr ?? "").trim());
  }
  console.log(`re-scoring ${answers.size} stored answers from ${probe}\n`);

  console.log("  persona            legal  character  judged  deviations");
  const perScenario: Record<string, string[]> = {};
  for (let pid = 0; pid < PERSONA_NAMES.length; pid++) {
    let legal = 0, nTot = 0, inChar = 0, charN = 0;
    const notes: string[] = [];
    for (const s of SCENARIOS) {
      for (let r = 0; r < 5; r++) {
        const a = answers.get(`PB|${pid}|${s.key}|r${r}`);
        if (a === undefined) continue;
        nTot++;
        if (s.allowed.includes(a)) legal++; else notes.push(`ILLEGAL ${s.key}:${a}`);
        (perScenario[s.key] ??= []).push(`${pid}:${a}`);
        const v = CHARACTER[PERSONA_NAMES[pid]]?.(a, s) ?? null;
        if (v !== null) { charN++; if (v) inChar++; else notes.push(`${s.key}:${a}`); }
      }
    }
    const pct = (x: number, d: number) => (d ? `${Math.round((x / d) * 100)}%`.padStart(4) : "  n/a");
    console.log(
      `  ${PERSONA_NAMES[pid].padEnd(18)} ${pct(legal, nTot)}   ${pct(inChar, charN)}    ${String(charN).padStart(3)}     ${[...new Set(notes)].join(" ")}`,
    );
  }

  console.log("\n  raw answers by scenario (persona:answer)");
  for (const s of SCENARIOS) {
    console.log(`  ${s.key.padEnd(16)} allowed=[${s.allowed.join(",")}]  ${(perScenario[s.key] ?? []).join(" ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
