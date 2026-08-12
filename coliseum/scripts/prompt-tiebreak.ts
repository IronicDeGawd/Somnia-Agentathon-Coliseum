/**
 * prompt-tiebreak.ts
 * ------------------
 * The elimination tournament scores LEGALITY, and every candidate saturates it.
 * This scores what legality cannot see: does the variant pick the action the
 * persona's own strategy calls for, and does it pick it CONSISTENTLY?
 *
 * Two metrics per variant:
 *   strategy  — matches the mean-reversion rule (buy weakness, sell strength,
 *               hold when flat), given what is actually executable.
 *   agreement — how often repeated identical calls return the same action.
 *               A variant that is legal but coin-flips is not stable.
 *
 * Run:
 *   PROBE_ADDRESS=0x... VARIANTS=V02,V09,V11 pnpm exec hardhat run scripts/prompt-tiebreak.ts --network somnia
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

interface Scenario {
  key: string; lots: number; cash: number; canBuy: boolean; moveBps: number; turn: string;
  legal: number[];
  /** What the mean-reversion persona should do, given what is executable. */
  ideal: number[];
  why: string;
}

// ideal[] allows more than one defensible answer; scoring is generous on purpose,
// because the point is to catch a variant that behaves erratically, not to grade taste.
const SCENARIOS: Scenario[] = [
  { key: "T1-sold-out-flat",   lots: 0, cash: 0.72, canBuy: true,  moveBps: 0,    turn: "3/3", legal: [0, 5],    ideal: [0],    why: "flat -> Hold is the rule" },
  { key: "T2-holds-up-big",    lots: 2, cash: 0.40, canBuy: true,  moveBps: 220,  turn: "2/3", legal: [0, 5, 6], ideal: [6],    why: "holds it and it ran up -> Sell" },
  { key: "T3-holds-down-big",  lots: 4, cash: 0.60, canBuy: true,  moveBps: -260, turn: "2/3", legal: [0, 5, 6], ideal: [5],    why: "fell hard -> Buy the dip" },
  { key: "T4-empty-broke",     lots: 0, cash: 0.01, canBuy: false, moveBps: -200, turn: "3/3", legal: [0],       ideal: [0],    why: "nothing is possible but Hold" },
  { key: "T5-opening-dip",     lots: 0, cash: 1.44, canBuy: true,  moveBps: -310, turn: "1/3", legal: [0, 5],    ideal: [5],    why: "big dip, full cash -> Buy" },
  { key: "T6-holds-flat",      lots: 3, cash: 0.30, canBuy: true,  moveBps: 10,   turn: "2/3", legal: [0, 5, 6], ideal: [0],    why: "flat -> Hold even while holding" },
];

const QUANT_ORIG = fs.existsSync("/tmp/quant_orig.txt") ? fs.readFileSync("/tmp/quant_orig.txt", "utf8").trim() :
  "You are The Quant: a systematic mean-reversion trader. Use the exact price move you are given each turn. If a pool moved DOWN more than ~0.5% (50bps), Buy it: it is below fair value. If a pool you ALREADY HOLD moved UP more than ~0.5% (50bps), Sell it: it is stretched. If you hold no base yet, Buy the biggest down-mover. Only Hold when every active pool moved less than 0.5% (flat). Act on the strongest signal available this turn. You begin each duel holding only USDso (cash) and zero base tokens. You can only Sell a pool where your current base holding (shown in your vault line) is above zero, so your FIRST move in any pool must be a Buy. Never try to Sell a pool you hold 0 base in; that order fails. If your signal says sell but you hold none, Buy the best alternative instead. POSITION RULE: You start each duel holding only USDso cash. You may only SELL a token you currently hold (your position in it is greater than zero); if you hold none of a token, your only valid moves for it are BUY or HOLD. Never attempt to SELL a token you do not currently hold.";
const QUANT_WORDS =
  "You are The Quant, a mean-reversion trader. Rules, in order: if the market fell noticeably, BuySOMI, because it is below fair value. If you hold SOMI and it rose noticeably, SellSOMI, because it is stretched. If the market is flat, Hold. You may only choose an action from the list of allowed actions you are given. That list already excludes anything you cannot afford or do not hold, so never reason about whether a move is possible; simply pick the best allowed action.";
const QUANT_STRICT =
  "You are The Quant, a systematic mean-reversion trader. Buy weakness, sell strength, hold when flat. Choose exactly one action from the allowed list you are given and nothing else. The allowed list is authoritative: it already excludes every action you cannot execute. Do not explain. Do not restate the market. Answer with the action only.";

function moveWord(bps: number): string {
  const a = Math.abs(bps);
  if (a < 50) return "flat";
  if (a < 150) return bps > 0 ? "up slightly" : "down slightly";
  if (a < 300) return bps > 0 ? "up" : "down";
  return bps > 0 ? "up sharply" : "down sharply";
}
const legalDigits = (s: Scenario) => s.legal.map(String);
const legalNames = (s: Scenario) => s.legal.map((i) => ACTIONS[i]);
const gatedMenu = (s: Scenario) => `Pick ${s.legal.map((i) => `${i}=${ACTIONS[i]}`).join(" ")}. Only those numbers are valid`;

interface Variant { id: string; desc: string; method: "number" | "string"; cot: boolean;
  build: (s: Scenario) => { prompt: string; system: string; allowed: string[] }; }

const ALL: Variant[] = [
  { id: "V02", desc: "gated menu only (= 5476f46, numerals kept)", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `duel 21 turn ${s.turn}. last action: SellSOMI. SOMI: ${s.cash.toFixed(2)} USDso / ${s.lots} lots held, price 0.803 (${moveWord(s.moveBps)}). ${gatedMenu(s)}` }) },
  { id: "V03", desc: "gated menu + qualitative price", method: "number", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: [],
      prompt: `turn ${s.turn}. SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots} lots and ${s.cash.toFixed(2)} USDso. ${gatedMenu(s)}` }) },
  { id: "V09", desc: "inferString, allowedValues = digits", method: "string", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: legalDigits(s),
      prompt: `duel turn ${s.turn}. SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots} lots, ${s.cash.toFixed(2)} USDso.` }) },
  { id: "V10", desc: "inferString, allowedValues = action names", method: "string", cot: false,
    build: (s) => ({ system: QUANT_WORDS, allowed: legalNames(s),
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : `${s.lots} lots of`} SOMI. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V11", desc: "names + strict no-prose system prompt", method: "string", cot: false,
    build: (s) => ({ system: QUANT_STRICT, allowed: legalNames(s),
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : "some"} SOMI. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V13", desc: "names + chainOfThought", method: "string", cot: true,
    build: (s) => ({ system: QUANT_WORDS, allowed: legalNames(s),
      prompt: `SOMI is ${moveWord(s.moveBps)}. You hold ${s.lots === 0 ? "no" : `${s.lots} lots of`} SOMI. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V14", desc: "names + full original persona", method: "string", cot: false,
    build: (s) => ({ system: QUANT_ORIG, allowed: legalNames(s),
      prompt: `Turn ${s.turn}. SOMI is ${moveWord(s.moveBps)}. Your vault: ${s.lots} lots of SOMI, ${s.cash.toFixed(2)} USDso cash. Allowed actions: ${legalNames(s).join(", ")}.` }) },
  { id: "V15", desc: "names + explicit 'hold NOTHING' phrasing", method: "string", cot: false,
    build: (s) => ({ system: QUANT_WORDS, allowed: legalNames(s),
      prompt: `${s.lots === 0 ? "You hold NOTHING in SOMI, so selling it is impossible." : `You hold ${s.lots} lots of SOMI.`} The market is ${moveWord(s.moveBps)}. ${s.canBuy ? "You can afford to buy." : "You cannot afford to buy."} Allowed actions: ${legalNames(s).join(", ")}.` }) },
];

function toIdx(v: Variant, asInt: bigint, asStr: string): number | null {
  if (v.method === "number") return Number(asInt);
  const s = (asStr ?? "").trim();
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
  const probe = process.env.PROBE_ADDRESS as `0x${string}`;
  if (!probe) throw new Error("set PROBE_ADDRESS");

  const pick = (process.env.VARIANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const variants = pick.length ? ALL.filter((v) => pick.includes(v.id)) : ALL;
  const REPS = Number(process.env.REPS ?? 3);

  const dep = (await pub.readContract({ address: PLATFORM, abi: parseAbi(["function getRequestDeposit() view returns (uint256)"]), functionName: "getRequestDeposit" })) as bigint;
  const perReq = dep + parseEther("0.21");
  const total = variants.length * SCENARIOS.length * REPS;
  const cost = perReq * BigInt(total);
  const bal = await pub.getBalance({ address: probe });
  if (bal < cost) {
    const top = cost - bal + parseEther("0.05");
    log(`funding ${formatEther(top)} STT for ${total} requests…`);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: probe, value: top }) });
  }

  log(`tiebreak: ${variants.length} variants x ${SCENARIOS.length} scenarios x ${REPS} = ${total} requests`);
  const fired: { id: string; v: Variant; s: Scenario }[] = [];
  for (const v of variants) for (const s of SCENARIOS) for (let r = 0; r < REPS; r++) {
    const { prompt, system, allowed } = v.build(s);
    const label = `TB|${v.id}|${s.key}|r${r}`;
    try {
      const h = v.method === "number"
        ? await wallet.writeContract({ address: probe, abi: art.abi, functionName: "probeNumber", args: [prompt, system, 0n, 6n, v.cot, label] })
        : await wallet.writeContract({ address: probe, abi: art.abi, functionName: "probeString", args: [prompt, system, v.cot, allowed, label] });
      await pub.waitForTransactionReceipt({ hash: h });
      fired.push({ id: label, v, s });
    } catch (e: unknown) { log("send failed", label, (e as { shortMessage?: string }).shortMessage ?? ""); }
  }
  log(`fired ${fired.length}, collecting…`);

  const got = new Map<string, number | null>();
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const n = (await pub.readContract({ address: probe, abi: art.abi, functionName: "probeCount" })) as bigint;
    got.clear();
    for (let i = 0n; i < n; i++) {
      const id = (await pub.readContract({ address: probe, abi: art.abi, functionName: "requestIds", args: [i] })) as bigint;
      const r = (await pub.readContract({ address: probe, abi: art.abi, functionName: "getProbe", args: [id] })) as unknown[];
      const [label, , answered, , , , asInt, asStr] = r as [string, boolean, boolean, number, bigint, string, bigint, string];
      if (!answered || !label.startsWith("TB|")) continue;
      const f = fired.find((x) => x.id === label);
      if (f) got.set(label, toIdx(f.v, asInt, asStr));
    }
    if (fired.every((f) => got.has(f.id))) break;
    await new Promise((r) => setTimeout(r, 8000));
  }

  console.log(`\n  variant  legal   strategy  agreement  notes`);
  const rows: { v: Variant; legal: number; strat: number; agree: number; n: number; notes: string[] }[] = [];
  for (const v of variants) {
    let legal = 0, strat = 0, agree = 0, n = 0; const notes: string[] = [];
    for (const s of SCENARIOS) {
      const picks: number[] = [];
      for (let r = 0; r < REPS; r++) {
        const a = got.get(`TB|${v.id}|${s.key}|r${r}`);
        if (a === undefined) continue;
        n++;
        if (a !== null && s.legal.includes(a)) legal++;
        if (a !== null && s.ideal.includes(a)) strat++; else if (a !== null) notes.push(`${s.key}:${ACTIONS[a] ?? a}`);
        if (a !== null) picks.push(a);
      }
      if (picks.length) {
        const mode = picks.sort((a, b) => picks.filter((x) => x === a).length - picks.filter((x) => x === b).length).pop()!;
        agree += picks.filter((x) => x === mode).length;
      }
    }
    rows.push({ v, legal, strat, agree, n, notes });
  }
  rows.sort((a, b) => (b.strat - a.strat) || (b.agree - a.agree));
  for (const r of rows) {
    const pct = (x: number) => r.n ? `${Math.round((x / r.n) * 100)}%`.padStart(4) : "  - ";
    console.log(`  ${r.v.id.padEnd(6)} ${pct(r.legal)}   ${pct(r.strat)}     ${pct(r.agree)}     ${[...new Set(r.notes)].slice(0, 4).join(" ")}`);
  }
  console.log(`\n  (strategy deviations listed as scenario:chosen-action)`);
  for (const r of rows) console.log(`  ${r.v.id} — ${r.v.desc} [${r.v.method}, cot=${r.v.cot}]`);
  console.log(`\nprobe balance: ${formatEther(await pub.getBalance({ address: probe }))} STT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
