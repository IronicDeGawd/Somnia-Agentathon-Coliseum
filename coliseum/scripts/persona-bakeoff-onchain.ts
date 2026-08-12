/**
 * persona-bakeoff-onchain.ts
 * --------------------------
 * Track A3: bake off all six live personas against the REAL Somnia agent.
 *
 * The prompt tournament only ever exercised The Quant. The other five carry
 * standing rules that can fight a holdings-gated action list — The Diamond Hand
 * must refuse a Sell even when one is offered, and The Degen must still accept
 * Hold when Hold is the only allowed action. Those are exactly the turns that
 * get burned, and they were never tested.
 *
 * Prompts are built to match `ArenaUtils.buildMarketSummary` as deployed: no
 * numerals, qualitative market language, and named actions. If that builder
 * changes, change these strings with it or the result stops meaning anything.
 *
 * Scores two things per persona:
 *   legality  — the answer is a member of the allowed set. Anything else is
 *               coerced to Hold on-chain, costing the fighter its turn.
 *   character — the answer obeys that persona's own standing rule.
 *
 * Costs roughly 0.214 STT per inference; the run prints the bill before firing.
 *
 * Run:
 *   PROBE_ADDRESS=0x.. REPS=2 pnpm exec hardhat run scripts/persona-bakeoff-onchain.ts --network somnia
 *   (omit PROBE_ADDRESS to deploy a fresh probe)
 */
import hre from "hardhat";
import { createWalletClient, http, parseEther, formatEther, defineChain, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { PERSONAS, PERSONA_NAMES } from "./personas";

const PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776" as const;
const AGENT_ID = BigInt("12847293847561029384");

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

interface Scenario {
  key: string;
  turn: string;      // "one of three"
  last: string;      // last action name
  move: string;      // exactly what moveWord() emits
  holds: boolean;
  allowed: string[]; // exactly what legalActions() would yield
}

// Mirrors the five holdings states the tournament used, so results compare.
const SCENARIOS: Scenario[] = [
  { key: "S1-nobase-flat",   turn: "three of three", last: "Hold",     move: "is flat",           holds: false, allowed: ["Hold", "BuySOMI"] },
  { key: "S2-holds-up",      turn: "two of three",   last: "BuySOMI",  move: "is up slightly",    holds: true,  allowed: ["Hold", "BuySOMI", "SellSOMI"] },
  { key: "S3-holds-nocash",  turn: "two of three",   last: "BuySOMI",  move: "is down slightly",  holds: true,  allowed: ["Hold", "SellSOMI"] },
  { key: "S4-empty-broke",   turn: "three of three", last: "SellSOMI", move: "is down",           holds: false, allowed: ["Hold"] },
  { key: "S5-opening",       turn: "one of three",   last: "Hold",     move: "has just opened, with no move to read yet", holds: false, allowed: ["Hold", "BuySOMI"] },
  { key: "S6-big-dip",       turn: "two of three",   last: "Hold",     move: "is down sharply",   holds: false, allowed: ["Hold", "BuySOMI"] },
];

/** Exactly the shape ArenaUtils.buildMarketSummary produces. */
function buildPrompt(s: Scenario): string {
  return (
    `This is turn ${s.turn}. Your last action was ${s.last}.` +
    ` SOMI ${s.move}. You hold ${s.holds ? "some " : "no "}SOMI.` +
    ` Allowed actions: ${s.allowed.join(", ")}.`
  );
}

/**
 * Each persona's standing rule. Returns null when the scenario cannot test it
 * (Hold as the only option cannot disprove "never hold"), so an untestable turn
 * is not scored as a failure.
 */
const CHARACTER: Record<string, (a: string, s: Scenario) => boolean | null> = {
  "The Degen":        (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Whale":        (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Quant":        (a, s) => (s.move === "is flat" ? a === "Hold" : s.move.includes("down") ? a === "BuySOMI" : null),
  "The Diamond Hand": (a) => !a.startsWith("Sell"),
  "The Scalper":      (a, s) => (s.allowed.length === 1 ? null : a !== "Hold"),
  "The Contrarian":   (a, s) => (s.move === "is flat" ? a === "Hold" : s.move.includes("down") ? a === "BuySOMI" : null),
};

async function main() {
  const pub = await hre.viem.getPublicClient();
  const rpcUrl: string =
    (hre.network.config as { url?: string }).url ?? "https://api.infra.testnet.somnia.network";
  const chain = defineChain({
    id: hre.network.config.chainId ?? 50312,
    name: "somnia",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const art = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "artifacts/contracts/PromptProbe.sol/PromptProbe.json"), "utf8"),
  );

  let probe = process.env.PROBE_ADDRESS as `0x${string}` | undefined;
  if (!probe) {
    log("deploying PromptProbe…");
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode as `0x${string}`, args: [PLATFORM, AGENT_ID] });
    probe = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    log("probe:", probe);
  } else {
    log("reusing probe:", probe);
  }

  const REPS = Number(process.env.REPS ?? 2);
  const total = PERSONAS.length * SCENARIOS.length * REPS;
  const dep = (await pub.readContract({
    address: PLATFORM, abi: parseAbi(["function getRequestDeposit() view returns (uint256)"]), functionName: "getRequestDeposit",
  })) as bigint;
  const perReq = dep + parseEther("0.21");
  const cost = perReq * BigInt(total);
  log(`${PERSONAS.length} personas x ${SCENARIOS.length} scenarios x ${REPS} reps = ${total} inferences, ~${formatEther(cost)} STT`);

  const bal = await pub.getBalance({ address: probe });
  if (bal < cost) {
    const top = cost - bal + parseEther("0.1");
    log(`funding probe with ${formatEther(top)} STT…`);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: probe, value: top }) });
  }

  const fired: { label: string; pid: number; s: Scenario }[] = [];
  for (let pid = 0; pid < PERSONAS.length; pid++) {
    for (const s of SCENARIOS) {
      for (let r = 0; r < REPS; r++) {
        const label = `PB|${pid}|${s.key}|r${r}`;
        try {
          const h = await wallet.writeContract({
            address: probe, abi: art.abi, functionName: "probeString",
            args: [buildPrompt(s), PERSONAS[pid], false, s.allowed, label],
          });
          await pub.waitForTransactionReceipt({ hash: h });
          fired.push({ label, pid, s });
        } catch (e: unknown) {
          log("send failed", label, (e as { shortMessage?: string }).shortMessage ?? "");
        }
      }
    }
    log(`  fired ${PERSONA_NAMES[pid]}`);
  }
  log(`fired ${fired.length}/${total}, collecting…`);

  const got = new Map<string, string>();
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const n = (await pub.readContract({ address: probe, abi: art.abi, functionName: "probeCount" })) as bigint;
    got.clear();
    for (let i = 0n; i < n; i++) {
      const id = (await pub.readContract({ address: probe, abi: art.abi, functionName: "requestIds", args: [i] })) as bigint;
      const r = (await pub.readContract({ address: probe, abi: art.abi, functionName: "getProbe", args: [id] })) as unknown[];
      const [label, , answered, , , , , asStr] = r as [string, boolean, boolean, number, bigint, string, bigint, string];
      if (!answered || !label.startsWith("PB|")) continue;
      got.set(label, (asStr ?? "").trim());
    }
    if (fired.every((f) => got.has(f.label))) break;
    await new Promise((r) => setTimeout(r, 8000));
  }
  log(`collected ${got.size}/${fired.length}`);

  console.log(`\n  persona            legal  character  answers`);
  let allLegal = true;
  for (let pid = 0; pid < PERSONAS.length; pid++) {
    let legal = 0, n = 0, inChar = 0, charN = 0;
    const notes: string[] = [];
    for (const s of SCENARIOS) {
      for (let r = 0; r < REPS; r++) {
        const a = got.get(`PB|${pid}|${s.key}|r${r}`);
        if (a === undefined) continue;
        n++;
        if (s.allowed.includes(a)) legal++;
        else { notes.push(`${s.key}!=${a || "(empty)"}`); allLegal = false; }
        const verdict = CHARACTER[PERSONA_NAMES[pid]]?.(a, s) ?? null;
        if (verdict !== null) { charN++; if (verdict) inChar++; else notes.push(`${s.key}:${a}`); }
      }
    }
    const pct = (x: number, d: number) => (d ? `${Math.round((x / d) * 100)}%`.padStart(4) : "  - ");
    console.log(`  ${PERSONA_NAMES[pid].padEnd(18)} ${pct(legal, n)}   ${pct(inChar, charN)}     ${[...new Set(notes)].slice(0, 4).join(" ")}`);
  }

  console.log(
    allLegal
      ? "\nAll six personas legal on every scenario — cleared for live duels."
      : "\nAt least one persona produced an inexecutable action (would be coerced to Hold on-chain).",
  );
  console.log(`probe ${probe} balance ${formatEther(await pub.getBalance({ address: probe }))} STT — run sweep() to reclaim`);
}

main().catch((e) => { console.error(e); process.exit(1); });
