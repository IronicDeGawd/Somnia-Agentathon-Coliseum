/**
 * check-persona-sync.mjs
 * ----------------------
 * Diffs the personas in scripts/personas.ts against contracts/lib/FighterPrompts.sol.
 *
 * The two must hold byte-identical text: personas.ts is what `setPrompt` pushes
 * onto the live registry, FighterPrompts.sol is what a fresh deploy seeds. They
 * have drifted before — the live Quant carried a "POSITION RULE" paragraph that
 * never made it back into source — and the drift is invisible until a redeploy
 * silently reverts prompts that were tuned on-chain.
 *
 * Also fails on any numeral, which is the hazard the V11 rewrite removes:
 * `inferNumber` extracts the first integer it finds in the model's reply.
 *
 * Plain node, no dependencies (the coliseum root has no node_modules on every
 * machine). Run:  node scripts/check-persona-sync.mjs
 */
import fs from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Concatenate a run of adjacent "..." literals, honouring escapes. */
function joinLiterals(block) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    out.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return out.join("");
}

// ── personas.ts ─────────────────────────────────────────────────────────────
const tsSrc = fs.readFileSync(path.join(root, "scripts/personas.ts"), "utf8");

const answerTs = joinLiterals(
  tsSrc.slice(
    tsSrc.indexOf("const ANSWER_CONTRACT ="),
    tsSrc.indexOf(";", tsSrc.indexOf("const ANSWER_CONTRACT =")),
  ),
);

const tsArray = tsSrc.slice(
  tsSrc.indexOf("export const PERSONAS"),
  tsSrc.indexOf("] as const;", tsSrc.indexOf("export const PERSONAS")),
);
// Split on the numbered persona comments so each entry is isolated.
const tsPersonas = tsArray
  .split(/\n\s*\/\/ \d+ — /)
  .slice(1)
  .map((chunk) => joinLiterals(chunk) + answerTs);

// ── FighterPrompts.sol ──────────────────────────────────────────────────────
const solSrc = fs.readFileSync(path.join(root, "contracts/lib/FighterPrompts.sol"), "utf8");

const answerSol = joinLiterals(
  solSrc.slice(
    solSrc.indexOf("string private constant ANSWER_CONTRACT ="),
    solSrc.indexOf(";", solSrc.indexOf("string private constant ANSWER_CONTRACT =")),
  ),
);

const ORDER = ["degen", "whale", "quant", "diamondHand", "scalper", "contrarian"];
const solPersonas = ORDER.map((fn) => {
  const start = solSrc.indexOf(`function ${fn}()`);
  if (start === -1) throw new Error(`FighterPrompts.sol has no ${fn}()`);
  const body = solSrc.slice(start, solSrc.indexOf("ANSWER_CONTRACT\n", start));
  return joinLiterals(body) + answerSol;
});

// ── Compare ─────────────────────────────────────────────────────────────────
let failures = 0;

if (answerTs !== answerSol) {
  console.error("MISMATCH: ANSWER_CONTRACT differs between personas.ts and FighterPrompts.sol");
  failures++;
}

for (let i = 0; i < ORDER.length; i++) {
  const a = tsPersonas[i];
  const b = solPersonas[i];
  if (a === undefined) {
    console.error(`MISSING: personas.ts has no entry ${i}`);
    failures++;
    continue;
  }
  if (a !== b) {
    console.error(`MISMATCH: ${ORDER[i]} (id ${i})`);
    const at = [...a].findIndex((c, j) => c !== b[j]);
    console.error(`  first difference at char ${at}`);
    console.error(`  ts : …${a.slice(Math.max(0, at - 40), at + 40)}…`);
    console.error(`  sol: …${b.slice(Math.max(0, at - 40), at + 40)}…`);
    failures++;
  }
  if (/\d/.test(a)) {
    console.error(`NUMERAL: ${ORDER[i]} (id ${i}) contains a digit; inferNumber could extract it`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem(s).`);
  process.exit(1);
}
console.log(`all ${ORDER.length} personas in sync, no numerals (${answerTs.length}b answer contract)`);
for (let i = 0; i < ORDER.length; i++) {
  console.log(`  ${i} ${ORDER[i].padEnd(12)} ${tsPersonas[i].length}b`);
}
