/**
 * perps-decisiveness.ts
 * ---------------------
 * Does a perps prompt give a fighter enough to act on?
 *
 * WHY THIS IS A SEPARATE HARNESS FROM prompt-tournament.ts. That one scores
 * LEGALITY — it asks whether the model returns an action the fighter could execute,
 * which was the right question for the bug that lost duel 21. It says nothing about
 * whether a fighter ACTS, and that is the whole failure here: measured on duel 89,
 * twelve moves and twelve Holds, with seven affordable actions offered every turn.
 *
 * WHAT IT MEASURES INSTEAD. Two scenario families, because both ways of being wrong
 * are real and a harness that only catches one is worse than useless:
 *
 *   QUIET — moves of a few basis points, matching what the venue actually does over
 *           a fight (5.6, 9.4 and 23.4 bps end-to-end on duel 89). A good prompt
 *           mostly HOLDS here. A prompt that always trades is not brave, it is
 *           paying the spread on noise, on purpose.
 *   LIVE  — one market has moved several hundred basis points while the others sat
 *           still. A good prompt TAKES A POSITION, and takes it in the direction the
 *           move points.
 *
 * A prompt passes when it separates the two. Today's wording does not: it holds
 * through both, because nothing in it distinguishes them.
 *
 * WHY IT RUNS HERE AND NOT AGAINST THE ARENA. `ArenaUtils` is a linked library, so
 * changing one string means redeploying four parts and re-pointing the router, which
 * is refused unless the arena is empty. Iterating wording that way is unaffordable.
 * This talks to the same on-chain model through PromptProbe, with no Arena involved.
 *
 * Run:
 *   PROBE_ADDRESS=0x… pnpm exec hardhat run scripts/perps-decisiveness.ts --network somnia
 *   (omit PROBE_ADDRESS to deploy a fresh probe; REPS= to sample more than once)
 *
 * COSTS REAL STT. Each request is an on-chain inference. variants × scenarios × reps.
 */
import hre from "hardhat";
import { createWalletClient, createPublicClient, http, defineChain, parseEther, formatEther, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import "dotenv/config";

const somnia = defineChain({
  id: 50312,
  name: "Somnia Shannon Testnet",
  nativeCurrency: { name: "Somnia Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  testnet: true,
});

const PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776" as const;
// The Arena's own agent, not agent 1. Using 1 made the platform revert every
// createRequest — the probe emitted ProbeFailed eight times, spent nothing, and the
// first version of this script cheerfully reported "sent" for all of them.
const AGENT_ID = BigInt("12847293847561029384");

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** keccak256("ProbeFailed(string,string)") — emitted when the platform refuses. */
const PROBE_FAILED_TOPIC = keccak256(toBytes("ProbeFailed(string,string)"));

/** The action names a perps fighter may answer with. Must match the Arena's set. */
const ALLOWED = [
  "Hold",
  "LongXRP", "ShortXRP",
  "LongADA", "ShortADA",
  "LongSOL", "ShortSOL",
];

interface Scenario {
  key: string;
  family: "quiet" | "live";
  /** The market line, as the Arena would build it. */
  slots: string;
  /** Which answers count as reading the situation correctly. */
  good: (answer: string) => boolean;
}

/**
 * The numbers here are the ones actually measured on duel 89 and duel 91, not
 * invented: a fight sees single-digit to low-double-digit basis points, and the
 * fighter starts flat with 2 USDso of collateral.
 */
const SCENARIOS: Scenario[] = [
  {
    key: "quiet-all-three",
    family: "quiet",
    slots:
      "SOL at 90.71, was 90.69 last turn. You are flat here. One position here costs 0.4536 USDso of margin. " +
      "ADA at 0.2093, was 0.2093 last turn. You are flat here. One position here costs 0.2093 USDso of margin. " +
      "XRP at 1.3131, was 1.3130 last turn. You are flat here. One position here costs 0.0656 USDso of margin.",
    // Holding is the RIGHT answer on noise. Trading here is the failure.
    good: (a) => a === "Hold",
  },
  {
    key: "quiet-with-drift",
    family: "quiet",
    slots:
      "SOL at 90.71, was 90.60 last turn, 90.55 when the fight opened. You are flat here. One position here costs 0.4536 USDso of margin. " +
      "ADA at 0.2093, was 0.2094 last turn, 0.2090 when the fight opened. You are flat here. One position here costs 0.2093 USDso of margin. " +
      "XRP at 1.3131, was 1.3129 last turn, 1.3125 when the fight opened. You are flat here. One position here costs 0.0656 USDso of margin.",
    good: (a) => a === "Hold",
  },
  {
    key: "live-sol-up",
    family: "live",
    slots:
      "SOL at 93.42, was 90.71 last turn, 90.55 when the fight opened. You are flat here. One position here costs 0.4536 USDso of margin. " +
      "That is the largest move of the fight so far, and upward. " +
      "ADA at 0.2093, was 0.2093 last turn. You are flat here. One position here costs 0.2093 USDso of margin. " +
      "XRP at 1.3131, was 1.3130 last turn. You are flat here. One position here costs 0.0656 USDso of margin.",
    // A 299bps move upward. Long SOL reads it; short SOL fights it; Hold ignores it.
    good: (a) => a === "LongSOL",
  },
  {
    key: "live-xrp-down",
    family: "live",
    slots:
      "SOL at 90.71, was 90.70 last turn. You are flat here. One position here costs 0.4536 USDso of margin. " +
      "ADA at 0.2093, was 0.2093 last turn. You are flat here. One position here costs 0.2093 USDso of margin. " +
      "XRP at 1.2610, was 1.3131 last turn, 1.3140 when the fight opened. You are flat here. One position here costs 0.0656 USDso of margin. " +
      "That is the largest move of the fight so far, and downward.",
    good: (a) => a === "ShortXRP",
  },
];

/** The persona. Held constant, so the only thing under test is the market wording. */
const SYSTEM =
  "You are a perpetual-futures trader in a scored duel. You may take a long or a short in any market, " +
  "or hold. Answer with exactly one action name from the allowed list and nothing else.";

interface Variant { key: string; head: (s: Scenario) => string }

const VARIANTS: Variant[] = [
  {
    // What shipped before today: state, no contest, no rank.
    key: "before",
    head: (s) =>
      "This is turn three of six. Your last action was Hold." +
      " Your score is 2.0000 USDso, from 2.00 at the start. Spare margin 2.0000 USDso. " +
      // The rank clause is part of the new wording, so strip it for the baseline.
      s.slots.replace(/ That is the largest move of the fight so far, and (upward|downward)\. /g, " ") +
      " Allowed actions: " + ALLOWED.join(", ") + ".",
  },
  {
    // Today's change: the contest sentence plus the rank clause.
    key: "after",
    head: (s) =>
      "This is turn three of six. Your last action was Hold." +
      " You are scored against the other fighter, and a book that never takes a position cannot win a fight." +
      " Your score is 2.0000 USDso, from 2.00 at the start. Spare margin 2.0000 USDso. " +
      s.slots +
      " Allowed actions: " + ALLOWED.join(", ") + ".",
  },
];

async function main() {
  const pk = process.env.PRIVATE_KEY as `0x${string}`;
  if (!pk) throw new Error("PRIVATE_KEY not set");
  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ chain: somnia, transport: http(somnia.rpcUrls.default.http[0]) });
  const wallet = createWalletClient({ account, chain: somnia, transport: http(somnia.rpcUrls.default.http[0]) });

  const reps = Number(process.env.REPS ?? "1");
  const artPath = path.join(process.cwd(), "artifacts/contracts/PromptProbe.sol/PromptProbe.json");
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));

  let probe = process.env.PROBE_ADDRESS as `0x${string}` | undefined;
  if (!probe) {
    log("deploying PromptProbe…");
    const hash = await wallet.deployContract({
      abi: art.abi, bytecode: art.bytecode as `0x${string}`,
      args: [PLATFORM, AGENT_ID], type: "legacy",
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    probe = rc.contractAddress!;
    log(`  probe at ${probe}`);
    // It pays each request's deposit out of its own balance.
    const fund = await wallet.sendTransaction({ to: probe, value: parseEther("2"), type: "legacy" });
    await pub.waitForTransactionReceipt({ hash: fund });
    log("  funded with 2 STT");
  }

  const total = VARIANTS.length * SCENARIOS.length * reps;
  log(`firing ${total} requests (${VARIANTS.length} variants × ${SCENARIOS.length} scenarios × ${reps})`);
  log(`probe balance: ${formatEther(await pub.getBalance({ address: probe }))} STT`);

  const sent: { id: string; variant: string; scenario: Scenario }[] = [];
  for (const v of VARIANTS) {
    for (const s of SCENARIOS) {
      for (let r = 0; r < reps; r++) {
        // RUN tags a sweep, so reusing a probe across sweeps does not overwrite the
        // earlier sweep's answers — the reader keys on the label, and two sweeps with
        // identical labels would silently collapse into one sample.
        const label = `${v.key}|${s.key}|${process.env.RUN ?? "0"}.${r}`;
        try {
          const hash = await wallet.writeContract({
            address: probe, abi: art.abi, functionName: "probeString",
            args: [v.head(s), SYSTEM, false, ALLOWED, label], type: "legacy",
          });
          const rc = await pub.waitForTransactionReceipt({ hash });
          // A SUCCESSFUL TRANSACTION IS NOT A SENT REQUEST. `_send` catches a
          // reverting createRequest and emits ProbeFailed, so the outer call
          // succeeds either way. Read the logs and believe those instead.
          const failed = rc.logs.some((l) => l.topics[0] === PROBE_FAILED_TOPIC);
          if (rc.status !== "success" || failed) {
            log(`  REFUSED ${label} — the platform would not take the request`);
            continue;
          }
          sent.push({ id: label, variant: v.key, scenario: s });
          log(`  sent ${label}`);
        } catch (e) {
          log(`  FAILED to send ${label}: ${String((e as Error).message).slice(0, 100)}`);
        }
      }
    }
  }

  log("waiting 90s for the agent to answer…");
  await new Promise((r) => setTimeout(r, 90_000));

  // Read every probe back and score it.
  const count = await pub.readContract({ address: probe, abi: art.abi, functionName: "probeCount", args: [] }) as bigint;
  const answers = new Map<string, string>();
  for (let i = 0n; i < count; i++) {
    const reqId = await pub.readContract({ address: probe, abi: art.abi, functionName: "requestIds", args: [i] }) as bigint;
    const p = await pub.readContract({ address: probe, abi: art.abi, functionName: "probes", args: [reqId] }) as unknown[];
    const label = p[0] as string;
    const answered = p[2] as boolean;
    const asString = p[7] as string;
    if (answered) answers.set(label, asString.trim());
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log("\n===== DECISIVENESS =====\n");
  for (const v of VARIANTS) {
    let quietRight = 0, quietTotal = 0, liveRight = 0, liveTotal = 0, unanswered = 0;
    const lines: string[] = [];
    for (const s of sent.filter((x) => x.variant === v.key)) {
      const a = answers.get(s.id);
      if (a === undefined) { unanswered += 1; lines.push(`  ${s.id.padEnd(34)} (no answer)`); continue; }
      const ok = s.scenario.good(a);
      if (s.scenario.family === "quiet") { quietTotal += 1; if (ok) quietRight += 1; }
      else { liveTotal += 1; if (ok) liveRight += 1; }
      lines.push(`  ${s.id.padEnd(34)} → ${a.padEnd(10)} ${ok ? "ok" : "MISREAD"}`);
    }
    console.log(`--- variant "${v.key}" ---`);
    lines.forEach((l) => console.log(l));
    console.log(`    quiet (should hold):  ${quietRight}/${quietTotal}`);
    console.log(`    live  (should trade): ${liveRight}/${liveTotal}`);
    if (unanswered) console.log(`    unanswered: ${unanswered} — NOT counted either way`);
    // NO DATA IS NOT A VERDICT. The first run of this script printed "does NOT
    // separate the two" for a variant whose every request had been refused, which
    // reads as a measured failure of the wording rather than of the harness.
    const verdict = (quietTotal + liveTotal) === 0
      ? "NO DATA — nothing was answered, so nothing is known"
      : (liveTotal > 0 && liveRight === liveTotal && quietRight === quietTotal)
        ? "separates quiet from live"
        : "does NOT separate the two";
    console.log(`    verdict: ${verdict}\n`);
  }
  console.log(`probe: ${probe}  (reuse with PROBE_ADDRESS to avoid redeploying)`);
  console.log("An unanswered request is not a Hold. It is missing data, and is reported as such.\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
