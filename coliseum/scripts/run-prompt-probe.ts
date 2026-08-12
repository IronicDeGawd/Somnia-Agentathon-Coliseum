/**
 * run-prompt-probe.ts
 * -------------------
 * Deploys PromptProbe (once) and fires a fixed battery of inference probes at the
 * Somnia LLM agent, then polls for the callbacks.
 *
 * Answers, with on-chain evidence:
 *   1. Does inferNumber clamp an out-of-range extracted integer to maxValue?
 *      (If yes, Arena's 0..6 range turns any large number into 6 = SellSOMI.)
 *   2. Which integer does the extractor pick out of a prose answer?
 *   3. Does inferString's allowedValues actually constrain the answer?
 *
 * Run:
 *   PROBE_ADDRESS=0x..  pnpm exec hardhat run scripts/run-prompt-probe.ts --network somnia
 *   (omit PROBE_ADDRESS to deploy a fresh probe)
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

// The Quant's live persona, exactly as stored in FighterRegistry.
const QUANT =
  "You are The Quant: a systematic mean-reversion trader. Use the exact price move you are given each turn. If a pool moved DOWN more than ~0.5% (50bps), Buy it: it is below fair value. If a pool you ALREADY HOLD moved UP more than ~0.5% (50bps), Sell it: it is stretched. If you hold no base yet, Buy the biggest down-mover. Only Hold when every active pool moved less than 0.5% (flat). Act on the strongest signal available this turn. You begin each duel holding only USDso (cash) and zero base tokens. You can only Sell a pool where your current base holding (shown in your vault line) is above zero, so your FIRST move in any pool must be a Buy. Never try to Sell a pool you hold 0 base in; that order fails. If your signal says sell but you hold none, Buy the best alternative instead. POSITION RULE: You start each duel holding only USDso cash. You may only SELL a token you currently hold (your position in it is greater than zero); if you hold none of a token, your only valid moves for it are BUY or HOLD. Never attempt to SELL a token you do not currently hold.";

// The exact market summary duel 21 turn 3 sent to fighter 2, recovered from the
// platform's RequestCreated event.
const DUEL21 =
  "duel 21 turn 3/3. last action: SellSOMI. SOMI: 0 USDso / 0.0 base price 0.803 (flat). Pick 0=Hold 5=BuySOMI 6=SellSOMI. Only those numbers are valid";

async function main() {
  const pub = await hre.viem.getPublicClient();
  const rpcUrl: string =
    (hre.network.config as { url?: string }).url ?? "https://api.infra.testnet.somnia.network";
  const chainId: number = hre.network.config.chainId ?? 50312;
  const chain = defineChain({
    id: chainId,
    name: "somnia",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const key = process.env.PRIVATE_KEY as `0x${string}`;
  if (!key) throw new Error("PRIVATE_KEY not set");
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  log("deployer:", account.address, formatEther(await pub.getBalance({ address: account.address })), "STT");

  const artPath = path.join(process.cwd(), "artifacts/contracts/PromptProbe.sol/PromptProbe.json");
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));

  let probe = process.env.PROBE_ADDRESS as `0x${string}` | undefined;
  if (!probe) {
    log("deploying PromptProbe…");
    const hash = await wallet.deployContract({
      abi: art.abi,
      bytecode: art.bytecode as `0x${string}`,
      args: [PLATFORM, AGENT_ID],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    probe = rc.contractAddress!;
    log("PromptProbe deployed:", probe);
  } else {
    log("reusing PromptProbe:", probe);
  }

  // Fund it: each request costs getRequestDeposit() + 0.21 STT.
  const dep = (await pub.readContract({
    address: PLATFORM,
    abi: parseAbi(["function getRequestDeposit() view returns (uint256)"]),
    functionName: "getRequestDeposit",
  })) as bigint;
  const perReq = dep + parseEther("0.21");
  log("deposit per request:", formatEther(perReq), "STT");

  const PROBES: { fn: "probeNumber" | "probeString"; args: unknown[]; label: string }[] = [
    // 1. CLAMP TEST. No ambiguity: the only number present is 803, far above max=6.
    //    If the result is 6, "extract then clamp" is confirmed and Arena's 0..6
    //    range converts any large number into SellSOMI.
    { fn: "probeNumber", args: ["Reply with exactly this and nothing else: 803", "", 0n, 6n, false, "clamp-high-803"], label: "clamp-high-803" },
    // 2. CLAMP TEST, low side. Expect 0 if clamping is symmetric.
    { fn: "probeNumber", args: ["Reply with exactly this and nothing else: -50", "", 0n, 6n, false, "clamp-low-neg50"], label: "clamp-low-neg50" },
    // 3. EXTRACTION RULE. Two numbers, first vs last differ, both in range.
    //    Tells us whether the extractor takes the first or the last integer.
    { fn: "probeNumber", args: ["Reply with exactly this and nothing else: 1 then 5", "", 0n, 6n, false, "extract-first-or-last"], label: "extract-first-or-last" },
    // 4. THE REAL CASE. Exact duel-21 prompt and persona, exact bounds Arena uses.
    { fn: "probeNumber", args: [DUEL21, QUANT, 0n, 6n, false, "duel21-replay"], label: "duel21-replay" },
    // 5. THE PROPOSED FIX. Same case, but the answer set is constrained to the two
    //    legal moves. If honoured, SellSOMI becomes structurally unreachable.
    { fn: "probeString", args: [DUEL21, QUANT, false, ["0", "5"], "allowedvalues-legal-only"], label: "allowedvalues-legal-only" },
  ];

  const needed = perReq * BigInt(PROBES.length);
  const bal = await pub.getBalance({ address: probe });
  if (bal < needed) {
    const top = needed - bal + parseEther("0.05");
    log(`funding probe with ${formatEther(top)} STT…`);
    const h = await wallet.sendTransaction({ to: probe, value: top });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  log("probe balance:", formatEther(await pub.getBalance({ address: probe })), "STT");

  for (const p of PROBES) {
    try {
      const h = await wallet.writeContract({ address: probe, abi: art.abi, functionName: p.fn, args: p.args });
      await pub.waitForTransactionReceipt({ hash: h });
      log(`sent  ${p.label}`);
    } catch (e: unknown) {
      log(`FAILED to send ${p.label}:`, (e as { shortMessage?: string }).shortMessage ?? String(e).slice(0, 120));
    }
  }

  // Poll for callbacks.
  log("waiting for callbacks (up to 5 min)…");
  const deadline = Date.now() + 5 * 60 * 1000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const n = (await pub.readContract({ address: probe, abi: art.abi, functionName: "probeCount" })) as bigint;
    let pending = 0;
    for (let i = 0n; i < n; i++) {
      const id = (await pub.readContract({ address: probe, abi: art.abi, functionName: "requestIds", args: [i] })) as bigint;
      const r = (await pub.readContract({ address: probe, abi: art.abi, functionName: "getProbe", args: [id] })) as unknown[];
      const [label, isString, answered, status, respCount, raw, asInt, asStr] = r as [string, boolean, boolean, number, bigint, string, bigint, string];
      if (!answered) { pending++; continue; }
      const k = String(id);
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`\n--- ${label} (req ${id}) ---`);
      console.log(`  method:        ${isString ? "inferString" : "inferNumber"}`);
      console.log(`  status:        ${status}   responses: ${respCount}`);
      console.log(`  raw:           ${raw}`);
      console.log(`  decoded int:   ${asInt}`);
      if (asStr) console.log(`  decoded str:   ${asStr}`);
    }
    if (pending === 0 && seen.size >= PROBES.length) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  log("done. probe address:", probe, "(run `sweep` to reclaim STT)");
}

main().catch((e) => { console.error(e); process.exit(1); });
