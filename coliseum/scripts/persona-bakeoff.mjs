/**
 * persona-bakeoff.mjs
 * -------------------
 * Track A3: bake off all six V11 personas against a local Qwen3-30B before any
 * of them touches the chain.
 *
 * The on-chain tournament only ever exercised The Quant. The other five carry
 * strategy rules that can conflict with a gated action list — The Diamond Hand
 * must never sell even when selling is offered, and The Degen must still accept
 * Hold when Hold is the only allowed action. Those are exactly the cases that
 * cost a turn, and they are free to test locally.
 *
 * Scores two things per persona:
 *   legality  — the answer is a member of the allowed set. Anything else would
 *               be coerced to Hold on-chain, burning the turn.
 *   character — the answer obeys the persona's own standing rule.
 *
 * This mirrors what Arena will send under Track B: a qualitative market line,
 * no numerals, and an allowed list built from real holdings. It does NOT use
 * the platform's `allowedValues` constraint, deliberately — the point is to see
 * what the model does when only the prompt is holding the line.
 *
 * Plain node, no dependencies. Requires the desktop vLLM box to be up.
 *
 * Run:
 *   node scripts/persona-bakeoff.mjs
 *   VLLM_URL=http://host:8000/v1 MODEL=qwen3-coder-architecture-reasoning \
 *     REPS=5 node scripts/persona-bakeoff.mjs
 */
import fs from "fs";
import path from "path";

const BASE = process.env.VLLM_URL ?? "http://100.109.141.17:8000/v1";
const MODEL = process.env.MODEL ?? "qwen3-coder-architecture-reasoning";
const REPS = Number(process.env.REPS ?? 3);

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// personas.ts is TypeScript; pull the strings out textually rather than adding
// a transpiler to a script that otherwise has zero dependencies.
function loadPersonas() {
  const src = fs.readFileSync(path.join(root, "scripts/personas.ts"), "utf8");
  const join = (block) => {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(block)) !== null) out.push(m[1].replace(/\\"/g, '"'));
    return out.join("");
  };
  const answer = join(
    src.slice(src.indexOf("const ANSWER_CONTRACT ="), src.indexOf(";", src.indexOf("const ANSWER_CONTRACT ="))),
  );
  const arr = src.slice(src.indexOf("export const PERSONAS"), src.indexOf("] as const;", src.indexOf("export const PERSONAS")));
  return arr.split(/\n\s*\/\/ \d+ — /).slice(1).map((c) => join(c) + answer);
}

const NAMES = ["The Degen", "The Whale", "The Quant", "The Diamond Hand", "The Scalper", "The Contrarian"];

// Same five holdings states the on-chain tournament used, so results compare.
const SCENARIOS = [
  { key: "S1-nobase-flat",   market: "flat",         holds: false, canBuy: true,  allowed: ["Hold", "BuySOMI"] },
  { key: "S2-holds-up",      market: "up slightly",  holds: true,  canBuy: true,  allowed: ["Hold", "BuySOMI", "SellSOMI"] },
  { key: "S3-holds-nocash",  market: "down slightly",holds: true,  canBuy: false, allowed: ["Hold", "SellSOMI"] },
  { key: "S4-empty-broke",   market: "down",         holds: false, canBuy: false, allowed: ["Hold"] },
  { key: "S5-opening-dip",   market: "down sharply", holds: false, canBuy: true,  allowed: ["Hold", "BuySOMI"] },
];

/**
 * Each persona's standing rule, as a predicate over the answer. Returns null
 * when the scenario cannot test the rule (e.g. Hold is the only option, so
 * "never hold" is unenforceable and should not be counted as a failure).
 */
const CHARACTER = {
  "The Degen":        (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Whale":        (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Quant":        (a, s) => (s.market === "flat" ? a === "Hold" : null),
  "The Diamond Hand": (a) => !a.startsWith("Sell"),
  "The Scalper":      (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Contrarian":   (a, s) => (s.market === "flat" ? a === "Hold" : null),
};

function userPrompt(s) {
  return (
    `The market is ${s.market}. You hold ${s.holds ? "some" : "no"} SOMI. ` +
    `Allowed actions: ${s.allowed.join(", ")}.`
  );
}

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 60_000);

async function ask(system, user) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      max_tokens: 64,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

/** The on-chain path matches an exact allowed value; anything else is coerced. */
function classify(reply, allowed) {
  const exact = allowed.find((a) => reply === a);
  if (exact) return { action: exact, clean: true };
  const loose = allowed.find((a) => new RegExp(`\\b${a}\\b`, "i").test(reply));
  return { action: loose ?? null, clean: false };
}

async function main() {
  const personas = loadPersonas();

  // Fail fast and clearly when the box is simply off, rather than timing out
  // once per call for the whole matrix.
  try {
    const probe = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!probe.ok) throw new Error(`${probe.status}`);
    const served = (await probe.json()).data?.map((m) => m.id) ?? [];
    if (!served.includes(MODEL)) {
      throw new Error(`model "${MODEL}" not served. available: ${served.join(", ") || "none"}`);
    }
  } catch (e) {
    console.error(`cannot reach vLLM at ${BASE}: ${e.message}`);
    console.error("is the desktop box up? set VLLM_URL/MODEL to override.");
    process.exit(2);
  }

  console.log(`model ${MODEL} @ ${BASE}, ${REPS} reps x ${SCENARIOS.length} scenarios x ${personas.length} personas`);
  console.log(`${personas.length * SCENARIOS.length * REPS} calls\n`);

  const rows = [];
  for (let id = 0; id < personas.length; id++) {
    let legal = 0, clean = 0, inChar = 0, charTested = 0, total = 0;
    const notes = [];

    for (const s of SCENARIOS) {
      for (let r = 0; r < REPS; r++) {
        let reply;
        try {
          reply = await ask(personas[id], userPrompt(s));
        } catch (e) {
          console.error(`  ${NAMES[id]} ${s.key} rep ${r}: ${e.message.slice(0, 120)}`);
          continue;
        }
        total++;
        const { action, clean: isClean } = classify(reply, s.allowed);
        if (action) legal++;
        else notes.push(`${s.key}: no allowed action in "${reply.slice(0, 60)}"`);
        if (isClean) clean++;

        if (action) {
          const verdict = CHARACTER[NAMES[id]](action, s);
          if (verdict !== null) {
            charTested++;
            if (verdict) inChar++;
            else notes.push(`${s.key}: out of character → ${action}`);
          }
        }
      }
    }

    const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
    rows.push({ name: NAMES[id], legal: pct(legal, total), clean: pct(clean, total), character: pct(inChar, charTested), total });
    console.log(
      `${NAMES[id].padEnd(18)} legal ${pct(legal, total).padStart(4)}  ` +
        `bare ${pct(clean, total).padStart(4)}  character ${pct(inChar, charTested).padStart(4)}  (${total} calls)`,
    );
    for (const n of [...new Set(notes)].slice(0, 5)) console.log(`    ${n}`);
  }

  const failed = rows.filter((r) => r.legal !== "100%");
  console.log(
    failed.length === 0
      ? "\nAll six personas legal on every scenario. Cleared for setPrompt once the Arena redeploy is live."
      : `\n${failed.length} persona(s) produced an inexecutable action: ${failed.map((r) => r.name).join(", ")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
