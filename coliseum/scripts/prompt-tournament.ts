/**
 * prompt-tournament.ts
 * --------------------
 * Multi-pass elimination tournament over prompt variants, run against the REAL
 * Somnia LLM agent via PromptProbe.
 *
 * The probe established two facts this is designed around:
 *   - inferNumber extracts the FIRST integer from the model's free text, then
 *     clamps to [min,max]. Arena's 0..6 turns any large echoed number into 6.
 *   - inferString(allowedValues) is honoured.
 *
 * Scoring is LEGALITY, not strategy: a variant fails when it returns an action
 * the fighter cannot execute given its holdings. That is the bug that cost a
 * player a duel; strategic quality is a separate question.
 *
 * Pass 1  — every variant x every scenario, 1 sample. Eliminate any variant
 *           with an illegal answer.
 * Pass 2+ — survivors re-run for stability with more samples; a variant must
 *           stay perfect to survive. Repeats until one pass eliminates nobody.
 *
 * Run:
 *   PROBE_ADDRESS=0x... pnpm exec hardhat run scripts/prompt-tournament.ts --network somnia
 */
import hre from "hardhat";
import { createWalletClient, http, parseEther, formatEther, defineChain, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776" as const;
const AGENT_ID = BigInt("12847293847561029384");
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

const ACTIONS = ["Hold", "BuyWBTC", "SellWBTC", "BuyWETH", "SellWETH", "BuySOMI", "SellSOMI"];

// ─── Scenarios ──────────────────────────────────────────────────────────────
// Each carries the ground truth: which action indices are actually executable.
interface Scenario {
  key: string;
  desc: string;
  lots: number;          // base lots held
  cash: number;          // USDso
  canBuy: boolean;       // cash >= minCost
  moveBps: number;       // price move this turn, signed
  turn: string;
  legal: number[];       // executable action indices
}

const SCENARIOS: Scenario[] = [
  // The duel-21 case: sold out, has cash, price flat. Sell is impossible.
  { key: "S1-nobase-flat",    desc: "0 lots, has cash, flat",        lots: 0, cash: 0.72, canBuy: true,  moveBps: 0,    turn: "3/3", legal: [0, 5] },
  // Holds stock and price ran up: sell is legal and strategically indicated.
  { key: "S2-holds-up",       desc: "2 lots, has cash, up 120bps",   lots: 2, cash: 0.40, canBuy: true,  moveBps: 120,  turn: "2/3", legal: [0, 5, 6] },
  // Holds stock, no cash left: only hold or sell.
  { key: "S3-holds-nocash",   desc: "6 lots, no cash, down 90bps",   lots: 6, cash: 0.02, canBuy: false, moveBps: -90,  turn: "2/3", legal: [0, 6] },
  // Broke and empty: Hold is the ONLY legal move.
  { key: "S4-empty-broke",    desc: "0 lots, no cash, down 200bps",  lots: 0, cash: 0.01, canBuy: false, moveBps: -200, turn: "3/3", legal: [0] },
  // Opening turn: cash only, big dip.
  { key: "S5-opening-dip",    desc: "0 lots, full cash, down 310bps",lots: 0, cash: 1.44, canBuy: true,  moveBps: -310, turn: "1/3", legal: [0, 5] },
];

const QUANT_ORIG =
  "You are The Quant: a systematic mean-reversion trader. Use the exact price move you are given each turn. If a pool moved DOWN more than ~0.5% (50bps), Buy it: it is below fair value. If a pool you ALREADY HOLD moved UP more than ~0.5% (50bps), Sell it: it is stretched. If you hold no base yet, Buy the biggest down-mover. Only Hold when every active pool moved less than 0.5% (flat). Act on the strongest signal available this turn. You begin each duel holding only USDso (cash) and zero base tokens. You can only Sell a pool where your current base holding (shown in your vault line) is above zero, so your FIRST move in any pool must be a Buy. Never try to Sell a pool you hold 0 base in; that order fails. If your signal says sell but you hold none, Buy the best alternative instead. POSITION RULE: You start each duel holding only USDso cash. You may only SELL a token you currently hold (your position in it is greater than zero); if you hold none of a token, your only valid moves for it are BUY or HOLD. Never attempt to SELL a token you do not currently hold.";

// Qualitative persona: same strategy, no numerals, action names instead of digits.
const QUANT_WORDS =
  "You are The Quant, a mean-reversion trader. Rules, in order: if the market fell noticeably, BuySOMI, because it is below fair value. If you hold SOMI and it rose noticeably, SellSOMI, because it is stretched. If the market is flat, Hold. You may only choose an action from the list of allowed actions you are given. That list already excludes anything you cannot afford or do not hold, so never reason about whether a move is possible; simply pick the best allowed action.";

// Numeral-free strategy phrasing that still keeps the original persona's spirit.
const QUANT_WORDS_STRICT =
  "You are The Quant, a systematic mean-reversion trader. Buy weakness, sell strength, hold when flat. Choose exactly one action from the allowed list you are given and nothing else. The allowed list is authoritative: it already excludes every action you cannot execute. Do not explain. Do not restate the market. Answer with the action only.";

// ─── Prompt builders ────────────────────────────────────────────────────────
function moveWord(bps: number): string {
  const a = Math.abs(bps);
  if (a < 50) return "flat";
  if (a < 150) return bps > 0 ? "up slightly" : "down slightly";
  if (a < 300) return bps > 0 ? "up" : "down";
  return bps > 0 ? "up sharply" : "down sharply";
}
function legalDigits(s: Scenario): string[] { return s.legal.map(String); }
function legalNames(s: Scenario): string[] { return s.legal.map((i) => ACTIONS[i]); }

// Menu that includes an illegal Sell, exactly as the deployed contract does.
function deployedMenu(s: Scenario): string {
  return `Pick 0=Hold 5=BuySOMI 6=SellSOMI. Only those numbers are valid`;
}
// Menu gated on holdings, as commit 5476f46 produces.
function gatedMenu(s: Scenario): string {
  return `Pick ${s.legal.map((i) => `${i}=${ACTIONS[i]}`).join(" ")}. Only those numbers are valid`;
}

interface Variant {
  id: string;
  desc: string;
  method: "number" | "string";
  cot: boolean;
  build: (s: Scenario) => { prompt: string; system: string; allowed: string[] };
}

const VARIANTS: Variant[] = [
  // --- Controls -----------------------------------------------------------
  { id: "V01-deployed-baseline", desc: "exactly what is live today (control)", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `duel 21 turn ${s.turn}. last action: SellSOMI. SOMI: ${Math.floor(s.cash)} USDso / ${s.lots}.0 base price 0.803 (${moveWord(s.moveBps)}). ${deployedMenu(s)}` }) },
  { id: "V02-gated-menu-only", desc: "5476f46 only: menu gated, numerals kept", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `duel 21 turn ${s.turn}. last action: SellSOMI. SOMI: ${s.cash.toFixed(2)} USDso / ${s.lots} lots held, price 0.803 (${moveWord(s.moveBps)}). ${gatedMenu(s)}` }) },

  // --- Numeral reduction, still inferNumber -------------------------------
  { id: "V03-no-price-numerals", desc: "gated menu + qualitative price", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `turn ${s.turn}. SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots} lots and ${s.cash.toFixed(2)} USDso. ${gatedMenu(s)}` }) },
  { id: "V04-no-numerals-at-all", desc: "gated menu, everything qualitative", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : "some"} SOMI and ${s.canBuy ? "enough" : "not enough"} cash to buy. ${gatedMenu(s)}` }) },
  { id: "V05-answer-first", desc: "answer instruction placed FIRST, before any data", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `Answer with one digit from this list and nothing else: ${legalDigits(s).join(" or ")}. ${legalDigits(s).map((d, i) => `${d}=${ACTIONS[s.legal[i]]}`).join(", ")}. Context: SOMI is ${moveWord(s.moveBps)}; you hold ${s.lots} lots.` }) },
  { id: "V06-system-carries-format", desc: "format rule moved into the system prompt", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG + " Answer with a single digit and no other text.", allowed: [],
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots} lots. ${gatedMenu(s)}` }) },
  { id: "V07-cot-enabled", desc: "gated menu + chainOfThought=true", method: "number", cot: true,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots} lots. ${gatedMenu(s)}` }) },
  { id: "V08-single-choice-framing", desc: "explicit 'choose one of' framing", method: "number", cot: false,
    build: (s) => ({ system: QUANT_WORDS_STRICT, allowed: [],
      prompt: `SOMI is ${moveWord(s.moveBps)}. Choose exactly one of: ${legalDigits(s).map((d, i) => `${d} (${ACTIONS[s.legal[i]]})`).join(", ")}.` }) },

  // --- inferString with allowedValues: digits ------------------------------
  { id: "V09-string-digits", desc: "inferString, allowedValues = legal digits", method: "string", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: legalDigits(s),
      prompt: `duel turn ${s.turn}. SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots} lots, ${s.cash.toFixed(2)} USDso.` }) },

  // --- inferString with allowedValues: action NAMES (no integers anywhere) --
  { id: "V10-string-names", desc: "inferString, allowedValues = action names", method: "string", cot: false,
    build: (s) => ({ system: QUANT_WORDS, allowed: legalNames(s),
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : `${s.lots} lots of`} SOMI. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V11-string-names-strict", desc: "names + strict no-prose system prompt", method: "string", cot: false,
    build: (s) => ({ system: QUANT_WORDS_STRICT, allowed: legalNames(s),
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : "some"} SOMI. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V12-string-names-minimal", desc: "names, minimal context, no persona flourish", method: "string", cot: false,
    build: (s) => ({ system: "Pick the best trading action from the allowed list. Buy weakness, sell strength, hold when flat.", allowed: legalNames(s),
      prompt: `Market: ${moveWord(s.moveBps)}. Position: ${s.lots === 0 ? "no SOMI" : `${s.lots} lots SOMI`}. Allowed: ${legalNames(s).join(", ")}.` }) },
  { id: "V13-string-names-cot", desc: "names + chainOfThought=true", method: "string", cot: true,
    build: (s) => ({ system: QUANT_WORDS, allowed: legalNames(s),
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : `${s.lots} lots of`} SOMI. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V14-string-names-verbose", desc: "names + full original persona retained", method: "string", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: legalNames(s),
      prompt: `Turn ${s.turn}. SOMI is ${moveWord(s.moveBps)}. Your vault: ${s.lots} lots of SOMI, ${s.cash.toFixed(2)} USDso cash. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V15-string-names-explicit-empty", desc: "names + explicit 'you hold NOTHING' phrasing", method: "string", cot: false,
    build: (s) => ({ system: QUANT_WORDS, allowed: legalNames(s),
      prompt: `${s.lots === 0 ? "You hold NOTHING in SOMI, so selling it is impossible." : `You hold ${s.lots} lots of SOMI.`} The market is ${moveWord(s.moveBps)}. ${s.canBuy ? "You can afford to buy." : "You cannot afford to buy."} Allowed actions: ${legalNames(s).join(", ")}.` }) },
];

// ─── Result interpretation ──────────────────────────────────────────────────
function toActionIndex(v: Variant, raw: { asInt: bigint; asString: string }): number | null {
  if (v.method === "number") return Number(raw.asInt);
  const s = (raw.asString ?? "").trim();
  if (/^[0-6]$/.test(s)) return Number(s);
  const i = ACTIONS.findIndex((a) => a.toLowerCase() === s.toLowerCase());
  return i >= 0 ? i : null;
}

async function main() {
  const pub = await hre.viem.getPublicClient();
  const rpcUrl: string = (hre.network.config as { url?: string }).url ?? "https://api.infra.testnet.somnia.network";
  const chain = defineChain({ id: hre.network.config.chainId ?? 50312, name: "somnia",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const art = JSON.parse(fs.readFileSync(path.join(process.cwd(), "artifacts/contracts/PromptProbe.sol/PromptProbe.json"), "utf8"));
  let probe = process.env.PROBE_ADDRESS as `0x${string}` | undefined;
  if (!probe) {
    const h = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode as `0x${string}`, args: [PLATFORM, AGENT_ID] });
    probe = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
    log("deployed probe:", probe);
  }
  const dep = (await pub.readContract({ address: PLATFORM, abi: parseAbi(["function getRequestDeposit() view returns (uint256)"]), functionName: "getRequestDeposit" })) as bigint;
  const perReq = dep + parseEther("0.21");

  const fired: { id: string; variant: Variant; scen: Scenario }[] = [];
  async function fire(v: Variant, s: Scenario, tag: string) {
    const { prompt, system, allowed } = v.build(s);
    const label = `${v.id}|${s.key}|${tag}`;
    try {
      const h = v.method === "number"
        ? await wallet.writeContract({ address: probe!, abi: art.abi, functionName: "probeNumber", args: [prompt, system, 0n, 6n, v.cot, label] })
        : await wallet.writeContract({ address: probe!, abi: art.abi, functionName: "probeString", args: [prompt, system, v.cot, allowed, label] });
      await pub.waitForTransactionReceipt({ hash: h });
      fired.push({ id: label, variant: v, scen: s });
    } catch (e: unknown) {
      log(`  send failed ${label}:`, (e as { shortMessage?: string }).shortMessage ?? "");
    }
  }

  async function collect(): Promise<Map<string, { action: number | null; legal: boolean; raw: string }>> {
    const out = new Map<string, { action: number | null; legal: boolean; raw: string }>();
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      const n = (await pub.readContract({ address: probe!, abi: art.abi, functionName: "probeCount" })) as bigint;
      out.clear();
      for (let i = 0n; i < n; i++) {
        const id = (await pub.readContract({ address: probe!, abi: art.abi, functionName: "requestIds", args: [i] })) as bigint;
        const r = (await pub.readContract({ address: probe!, abi: art.abi, functionName: "getProbe", args: [id] })) as unknown[];
        const [label, , answered, , , , asInt, asString] = r as [string, boolean, boolean, number, bigint, string, bigint, string];
        if (!answered) continue;
        const f = fired.find((x) => x.id === label);
        if (!f) continue;
        const action = toActionIndex(f.variant, { asInt, asString });
        out.set(label, { action, legal: action !== null && f.scen.legal.includes(action), raw: asString || String(asInt) });
      }
      if (fired.every((f) => out.has(f.id))) break;
      await new Promise((r) => setTimeout(r, 8000));
    }
    return out;
  }

  // ── Passes ───────────────────────────────────────────────────────────────
  let alive = [...VARIANTS];
  const history: string[] = [];
  let pass = 1;
  const SAMPLES = [1, 2, 3];

  while (pass <= SAMPLES.length && alive.length > 1) {
    const reps = SAMPLES[pass - 1];
    const total = alive.length * SCENARIOS.length * reps;
    const cost = perReq * BigInt(total);
    const bal = await pub.getBalance({ address: probe });
    if (bal < cost) {
      const top = cost - bal + parseEther("0.1");
      log(`funding probe ${formatEther(top)} STT for pass ${pass} (${total} requests)…`);
      const h = await wallet.sendTransaction({ to: probe, value: top });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    log(`\n===== PASS ${pass}: ${alive.length} variants x ${SCENARIOS.length} scenarios x ${reps} = ${total} requests =====`);
    fired.length = 0;
    for (const v of alive) for (const s of SCENARIOS) for (let r = 0; r < reps; r++) await fire(v, s, `p${pass}r${r}`);
    log(`fired ${fired.length}, waiting for callbacks…`);
    const res = await collect();

    const score = new Map<string, { ok: number; bad: number; miss: number; fails: string[] }>();
    for (const v of alive) score.set(v.id, { ok: 0, bad: 0, miss: 0, fails: [] });
    for (const f of fired) {
      const sc = score.get(f.variant.id)!;
      const r = res.get(f.id);
      if (!r) { sc.miss++; continue; }
      if (r.legal) sc.ok++;
      else { sc.bad++; sc.fails.push(`${f.scen.key}->${r.action !== null ? ACTIONS[r.action] ?? r.action : `unparsed:${r.raw}`}`); }
    }
    console.log(`\n  variant                        ok  illegal  noreply  failures`);
    const ranked = [...alive].sort((a, b) => (score.get(b.id)!.ok - score.get(a.id)!.ok) || (score.get(a.id)!.bad - score.get(b.id)!.bad));
    for (const v of ranked) {
      const s = score.get(v.id)!;
      console.log(`  ${v.id.padEnd(30)} ${String(s.ok).padStart(2)}  ${String(s.bad).padStart(7)}  ${String(s.miss).padStart(7)}  ${s.fails.slice(0, 3).join(", ")}`);
    }
    const survivors = alive.filter((v) => { const s = score.get(v.id)!; return s.bad === 0 && s.miss === 0; });
    history.push(`pass ${pass}: ${alive.length} -> ${survivors.length}`);
    if (survivors.length === 0) { log("\nNo variant survived this pass. Keeping the best scorer(s) for inspection."); break; }
    alive = survivors;
    pass++;
  }

  console.log(`\n===== RESULT =====`);
  console.log(history.join("  |  "));
  console.log(`\nPerfect across every pass (${alive.length}):`);
  for (const v of alive) console.log(`  ${v.id}  — ${v.desc}  [${v.method}, cot=${v.cot}]`);
  console.log(`\nprobe: ${probe}  balance: ${formatEther(await pub.getBalance({ address: probe }))} STT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
