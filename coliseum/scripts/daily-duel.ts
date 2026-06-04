/**
 * daily-duel.ts
 * -------------
 * One-shot PvP duel runner. Triggered by cron once per day.
 * Runs Player1 vs Player2 in a 3-turn duel on Somnia testnet,
 * drives it to resolution, and claims winnings for both players.
 *
 * Run:
 *   pnpm exec hardhat run scripts/daily-duel.ts --network somnia
 *
 * Required env:
 *   PLAYER1_PRIVATE_KEY  — 0x-prefixed private key for player 1
 *   PLAYER2_PRIVATE_KEY  — 0x-prefixed private key for player 2
 *   PRIVATE_KEY          — deployer/owner key (already in hardhat.config.ts)
 */

import hre from "hardhat";
import {
  createWalletClient,
  http,
  formatUnits,
  parseEther,
  maxUint256,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtU(v: bigint, decimals = 18): string {
  return formatUnits(v, decimals);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TURNS = 3;
const TOTAL_CALLBACKS = TURNS * 2; // 6
const TURN_INTERVAL_BLOCKS = 600;
const EMERGENCY_FINALIZE_BLOCKS = 1000;
const POLL_INTERVAL_MS = 10_000; // 10 s
const WALL_CLOCK_CAP_MS = 10 * 60 * 1000; // 10 min overall cap

// ---------------------------------------------------------------------------
// ABIs (minimal — only what this script calls)
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const MATCHMAKER_ABI = [
  {
    name: "halfDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "turns", type: "uint16" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "queue",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "fighter", type: "uint8" },
      { name: "turns", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "triggerPendingMatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "turns", type: "uint16" }],
    outputs: [],
  },
  {
    name: "claimWinnings",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "duelId", type: "uint256" }],
    outputs: [],
  },
] as const;

const ARENA_ABI = [
  {
    name: "activeDuelId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "duels",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "duelId", type: "uint256" }],
    outputs: [
      { name: "fighterA", type: "uint8" },
      { name: "fighterB", type: "uint8" },
      { name: "creator", type: "address" },
      { name: "startBlock", type: "uint256" },
      { name: "lastTurnBlock", type: "uint256" },
      { name: "completedCallbacks", type: "uint16" },
      { name: "turns", type: "uint16" },
      { name: "poolMask", type: "uint8" },
      { name: "status", type: "uint8" },
      { name: "initialUsdsoPerFighter", type: "uint256" },
      { name: "fundsRecovered", type: "bool" },
      { name: "winnerSlot", type: "uint8" },
    ],
  },
  {
    name: "turn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "finalizeDuel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "duelId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "emergencyFinalize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "duelId", type: "uint256" }],
    outputs: [],
  },
] as const;

const BOOKMAKER_ABI = [
  {
    name: "initializeOdds",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "duelId", type: "uint256" },
      { name: "oddsA", type: "uint16" },
      { name: "oddsB", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

const DUEL_HISTORY_ABI = [
  {
    name: "totalDuels",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Duel tuple helper (index-based access)
// ---------------------------------------------------------------------------

interface DuelState {
  fighterA: number;
  fighterB: number;
  creator: string;
  startBlock: bigint;
  lastTurnBlock: bigint;
  completedCallbacks: number;
  turns: number;
  poolMask: number;
  status: number; // 1=Active 2=Finalizing 3=Resolved
  initialUsdsoPerFighter: bigint;
  fundsRecovered: boolean;
  winnerSlot: number;
}

function parseDuelTuple(raw: readonly unknown[]): DuelState {
  return {
    fighterA: Number(raw[0]),
    fighterB: Number(raw[1]),
    creator: raw[2] as string,
    startBlock: raw[3] as bigint,
    lastTurnBlock: raw[4] as bigint,
    completedCallbacks: Number(raw[5]),
    turns: Number(raw[6]),
    poolMask: Number(raw[7]),
    status: Number(raw[8]),
    initialUsdsoPerFighter: raw[9] as bigint,
    fundsRecovered: raw[10] as boolean,
    winnerSlot: Number(raw[11]),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== daily-duel starting ===");

  // -- Network / chain setup -------------------------------------------------
  const network = hre.network.name;
  const rpcUrl: string =
    (hre.network.config as { url?: string }).url ??
    "https://api.infra.testnet.somnia.network";
  const chainId: number = hre.network.config.chainId ?? 50312;

  log(`Network: ${network}  chainId: ${chainId}  rpc: ${rpcUrl}`);

  const somniaChain = defineChain({
    id: chainId,
    name: "Somnia Testnet",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  // -- Load deployment manifest ----------------------------------------------
  const manifestPath = path.join(
    __dirname,
    "..",
    "deployments",
    `${network}.json`
  );
  if (!fs.existsSync(manifestPath)) {
    log(`ERROR: No deployment manifest at ${manifestPath}`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  const arenaAddr = manifest.contracts.Arena.address as `0x${string}`;
  const bookmkAddr = manifest.contracts.Bookmaker.address as `0x${string}`;
  const matchmkAddr = manifest.contracts.Matchmaker.address as `0x${string}`;
  const usdsoAddr = manifest.external.usdso as `0x${string}`;
  const historyAddr = manifest.contracts.DuelHistory?.address as
    | `0x${string}`
    | undefined;

  log(`Arena:      ${arenaAddr}`);
  log(`Bookmaker:  ${bookmkAddr}`);
  log(`Matchmaker: ${matchmkAddr}`);
  log(`USDso:      ${usdsoAddr}`);
  if (historyAddr) log(`DuelHistory: ${historyAddr}`);

  // -- Clients ---------------------------------------------------------------
  // Owner wallet — from hardhat's configured account (PRIVATE_KEY in .env)
  const [ownerWallet] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  // Player wallets — from env vars, using viem directly
  const p1Key = process.env.PLAYER1_PRIVATE_KEY;
  const p2Key = process.env.PLAYER2_PRIVATE_KEY;

  if (!p1Key || !p2Key) {
    log("ERROR: PLAYER1_PRIVATE_KEY and PLAYER2_PRIVATE_KEY must be set");
    process.exitCode = 1;
    return;
  }

  const p1Account = privateKeyToAccount(p1Key as `0x${string}`);
  const p2Account = privateKeyToAccount(p2Key as `0x${string}`);

  const p1Wallet = createWalletClient({
    account: p1Account,
    chain: somniaChain,
    transport: http(rpcUrl),
  });
  const p2Wallet = createWalletClient({
    account: p2Account,
    chain: somniaChain,
    transport: http(rpcUrl),
  });

  const p1 = p1Account.address;
  const p2 = p2Account.address;
  log(`Player1: ${p1}`);
  log(`Player2: ${p2}`);
  log(`Owner:   ${ownerWallet.account.address}`);

  // -- Step 1: Preflight checks ----------------------------------------------
  log("--- PREFLIGHT ---");

  const activeDuelIdPre = (await publicClient.readContract({
    address: arenaAddr,
    abi: ARENA_ABI,
    functionName: "activeDuelId",
  })) as bigint;

  let duelId: bigint = BigInt(0);
  const resuming = activeDuelIdPre !== BigInt(0);
  if (resuming) {
    duelId = activeDuelIdPre;
    log(`Arena busy — RESUMING active duel ${duelId} (finish it instead of starting a new one; prevents a crashed run from wedging the bot).`);
  } else {
    log("Arena is free — proceeding");
  }

  // Ensure the Arena holds enough STT for this run's LLM inference deposits
  // (~0.24 STT/move × 6 moves for a 3-turn duel). The watcher no longer keeps
  // the Arena topped up (ARENA_MIN_STT=0 — the every-block reactivity
  // subscription is left to drain and deactivate, killing the idle STT burn),
  // so the keeper funds the fuel just-in-time here.
  const ARENA_FUEL_MIN    = parseEther("4");
  const ARENA_FUEL_TARGET = parseEther("6");
  const arenaStt = await publicClient.getBalance({ address: arenaAddr });
  log(`Arena STT: ${fmtU(arenaStt)}`);
  if (arenaStt < ARENA_FUEL_MIN) {
    const topup = ARENA_FUEL_TARGET - arenaStt;
    log(`Arena below fuel floor — sending ${fmtU(topup)} STT from owner...`);
    const fuelTx = await ownerWallet.sendTransaction({ to: arenaAddr, value: topup });
    await publicClient.waitForTransactionReceipt({ hash: fuelTx });
    log(`  arena fuel tx=${fuelTx} status=success`);
  }

  if (!resuming) {
  const halfDeposit = (await publicClient.readContract({
    address: matchmkAddr,
    abi: MATCHMAKER_ABI,
    functionName: "halfDeposit",
    args: [TURNS],
  })) as bigint;
  log(`halfDeposit(${TURNS}): ${fmtU(halfDeposit)} USDso`);

  const [p1UsdBal, p2UsdBal, p1SttBal, p2SttBal] = await Promise.all([
    publicClient.readContract({
      address: usdsoAddr,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [p1],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: usdsoAddr,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [p2],
    }) as Promise<bigint>,
    publicClient.getBalance({ address: p1 }),
    publicClient.getBalance({ address: p2 }),
  ]);

  log(
    `P1 balances: USDso=${fmtU(p1UsdBal)}  STT=${fmtU(p1SttBal)} (gas)`
  );
  log(
    `P2 balances: USDso=${fmtU(p2UsdBal)}  STT=${fmtU(p2SttBal)} (gas)`
  );

  if (p1UsdBal < halfDeposit || p2UsdBal < halfDeposit) {
    log(
      `ERROR: Insufficient USDso. Need ${fmtU(halfDeposit)} each. ` +
        `P1=${fmtU(p1UsdBal)}, P2=${fmtU(p2UsdBal)}`
    );
    process.exitCode = 1;
    return;
  }

  const MIN_GAS_STT = BigInt("50000000000000000"); // 0.05 STT
  if (p1SttBal < MIN_GAS_STT || p2SttBal < MIN_GAS_STT) {
    log(
      `ERROR: Insufficient STT for gas. Need at least 0.05 STT each. ` +
        `P1=${fmtU(p1SttBal)}, P2=${fmtU(p2SttBal)}`
    );
    process.exitCode = 1;
    return;
  }

  // -- Step 2: Pick fighters -------------------------------------------------
  log("--- FIGHTER SELECTION ---");

  let totalDuelsCount = BigInt(0);
  if (historyAddr) {
    try {
      totalDuelsCount = (await publicClient.readContract({
        address: historyAddr,
        abi: DUEL_HISTORY_ABI,
        functionName: "totalDuels",
      })) as bigint;
    } catch (e) {
      log(`DuelHistory.totalDuels() read failed (non-fatal): ${e}`);
    }
  }

  const idx = Number(totalDuelsCount % BigInt(6));
  const fighterA = idx % 6;
  let fighterB = (idx + 1) % 6;
  if (fighterB === fighterA) fighterB = (fighterA + 1) % 6;

  log(
    `totalDuels=${totalDuelsCount}  fighterA=${fighterA}  fighterB=${fighterB}`
  );

  // -- Step 3: P1 approve + queue -------------------------------------------
  log("--- P1 QUEUE ---");

  const p1Allowance = (await publicClient.readContract({
    address: usdsoAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [p1, matchmkAddr],
  })) as bigint;

  if (p1Allowance < halfDeposit) {
    log(`P1 approving USDso→Matchmaker (maxUint256)...`);
    const approveTx = await p1Wallet.writeContract({
      address: usdsoAddr,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [matchmkAddr, maxUint256],
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTx,
    });
    log(`P1 approve tx=${approveTx} status=${approveReceipt.status}`);
    if (approveReceipt.status === "reverted") {
      log("ERROR: P1 approve reverted");
      process.exitCode = 1;
      return;
    }
  } else {
    log(`P1 allowance sufficient (${fmtU(p1Allowance)})`);
  }

  log(`P1 queue(fighter=${fighterA}, turns=${TURNS})...`);
  const p1QueueTx = await p1Wallet.writeContract({
    address: matchmkAddr,
    abi: MATCHMAKER_ABI,
    functionName: "queue",
    args: [fighterA, TURNS],
  });
  const p1QueueReceipt = await publicClient.waitForTransactionReceipt({
    hash: p1QueueTx,
  });
  log(
    `P1 queue tx=${p1QueueTx} status=${p1QueueReceipt.status} block=${p1QueueReceipt.blockNumber}`
  );
  if (p1QueueReceipt.status === "reverted") {
    log("ERROR: P1 queue reverted");
    process.exitCode = 1;
    return;
  }

  // -- Step 4: P2 approve + queue -------------------------------------------
  log("--- P2 QUEUE ---");

  const p2Allowance = (await publicClient.readContract({
    address: usdsoAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [p2, matchmkAddr],
  })) as bigint;

  if (p2Allowance < halfDeposit) {
    log(`P2 approving USDso→Matchmaker (maxUint256)...`);
    const approveTx2 = await p2Wallet.writeContract({
      address: usdsoAddr,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [matchmkAddr, maxUint256],
    });
    const approveReceipt2 = await publicClient.waitForTransactionReceipt({
      hash: approveTx2,
    });
    log(`P2 approve tx=${approveTx2} status=${approveReceipt2.status}`);
    if (approveReceipt2.status === "reverted") {
      log("ERROR: P2 approve reverted");
      process.exitCode = 1;
      return;
    }
  } else {
    log(`P2 allowance sufficient (${fmtU(p2Allowance)})`);
  }

  log(`P2 queue(fighter=${fighterB}, turns=${TURNS})...`);
  const p2QueueTx = await p2Wallet.writeContract({
    address: matchmkAddr,
    abi: MATCHMAKER_ABI,
    functionName: "queue",
    args: [fighterB, TURNS],
  });
  const p2QueueReceipt = await publicClient.waitForTransactionReceipt({
    hash: p2QueueTx,
  });
  log(
    `P2 queue tx=${p2QueueTx} status=${p2QueueReceipt.status} block=${p2QueueReceipt.blockNumber}`
  );
  if (p2QueueReceipt.status === "reverted") {
    log("ERROR: P2 queue reverted");
    process.exitCode = 1;
    return;
  }

  // -- Read activeDuelId — P2 queue should have triggered Arena.startDuel ----
  duelId = (await publicClient.readContract({
    address: arenaAddr,
    abi: ARENA_ABI,
    functionName: "activeDuelId",
  })) as bigint;

  if (duelId === BigInt(0)) {
    log(
      "activeDuelId still 0 after P2 queue — trying triggerPendingMatch..."
    );
    try {
      const triggerTx = await ownerWallet.writeContract({
        address: matchmkAddr,
        abi: MATCHMAKER_ABI,
        functionName: "triggerPendingMatch",
        args: [TURNS],
      });
      const triggerReceipt = await publicClient.waitForTransactionReceipt({
        hash: triggerTx,
      });
      log(`triggerPendingMatch tx=${triggerTx} status=${triggerReceipt.status}`);
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? (e as { shortMessage?: string }).shortMessage ?? e.message
          : String(e);
      log(`triggerPendingMatch failed (non-fatal): ${msg}`);
    }

    duelId = (await publicClient.readContract({
      address: arenaAddr,
      abi: ARENA_ABI,
      functionName: "activeDuelId",
    })) as bigint;
  }

  if (duelId === BigInt(0)) {
    log("ERROR: activeDuelId is still 0 — duel did not start. Aborting.");
    process.exitCode = 1;
    return;
  }
  log(`Duel started — duelId=${duelId}`);
  } // end fresh-queue path (skipped when resuming an already-active duel)

  // -- Step 5: initializeOdds -----------------------------------------------
  log("--- INITIALIZE ODDS ---");
  try {
    const oddsTx = await ownerWallet.writeContract({
      address: bookmkAddr,
      abi: BOOKMAKER_ABI,
      functionName: "initializeOdds",
      args: [duelId, 5000, 5000],
    });
    const oddsReceipt = await publicClient.waitForTransactionReceipt({
      hash: oddsTx,
    });
    log(`initializeOdds tx=${oddsTx} status=${oddsReceipt.status}`);
  } catch (e: unknown) {
    const msg =
      e instanceof Error
        ? (e as { shortMessage?: string }).shortMessage ?? e.message
        : String(e);
    log(`initializeOdds failed (non-fatal): ${msg}`);
  }

  // -- Step 6: Drive turns ---------------------------------------------------
  log("--- TURN LOOP ---");

  const turnLoopDeadline = Date.now() + WALL_CLOCK_CAP_MS;
  let lastTurnFiredAt = Date.now();
  let turnsFired = 0;

  while (Date.now() < turnLoopDeadline) {
    // Read current duel state
    const rawDuel = (await publicClient.readContract({
      address: arenaAddr,
      abi: ARENA_ABI,
      functionName: "duels",
      args: [duelId],
    })) as readonly unknown[];
    const duel = parseDuelTuple(rawDuel);

    log(
      `[turn-loop] status=${duel.status} completedCallbacks=${duel.completedCallbacks}/${TOTAL_CALLBACKS} ` +
        `lastTurnBlock=${duel.lastTurnBlock} turnsFired=${turnsFired}`
    );

    // Already resolved?
    if (duel.status === 3) {
      log("Duel is already Resolved — skipping to finalize step");
      break;
    }

    // All callbacks in — ready to finalize
    if (duel.completedCallbacks >= TOTAL_CALLBACKS) {
      log("All callbacks received — exiting turn loop to finalize");
      break;
    }

    // Check if we can fire next turn (block-gated)
    const currentBlock = await publicClient.getBlockNumber();
    const blocksNeeded = duel.lastTurnBlock + BigInt(TURN_INTERVAL_BLOCKS);

    if (currentBlock >= blocksNeeded && turnsFired < TURNS) {
      log(
        `Block ${currentBlock} >= ${blocksNeeded} — calling turn() (turn #${turnsFired + 1})...`
      );
      try {
        const turnTx = await ownerWallet.writeContract({
          address: arenaAddr,
          abi: ARENA_ABI,
          functionName: "turn",
          args: [],
        });
        const turnReceipt = await publicClient.waitForTransactionReceipt({
          hash: turnTx,
        });
        log(
          `turn() tx=${turnTx} status=${turnReceipt.status} block=${turnReceipt.blockNumber}`
        );
        if (turnReceipt.status !== "reverted") {
          turnsFired++;
          lastTurnFiredAt = Date.now();
        }
      } catch (e: unknown) {
        const msg =
          e instanceof Error
            ? (e as { shortMessage?: string }).shortMessage ?? e.message
            : String(e);
        log(`turn() failed (non-fatal, will retry): ${msg}`);
      }
    } else {
      const blocksLeft = blocksNeeded - currentBlock;
      log(
        `Waiting for next turn window: ${blocksLeft} blocks remaining (current=${currentBlock})`
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // -- Step 7: Finalize ------------------------------------------------------
  log("--- FINALIZE ---");

  // Re-read final duel state
  const rawDuelFinal = (await publicClient.readContract({
    address: arenaAddr,
    abi: ARENA_ABI,
    functionName: "duels",
    args: [duelId],
  })) as readonly unknown[];
  const duelFinal = parseDuelTuple(rawDuelFinal);

  log(
    `Pre-finalize state: status=${duelFinal.status} completedCallbacks=${duelFinal.completedCallbacks} winnerSlot=${duelFinal.winnerSlot}`
  );

  if (duelFinal.status === 3) {
    log("Duel already Resolved — skipping finalize call");
  } else if (duelFinal.completedCallbacks >= TOTAL_CALLBACKS) {
    // Normal finalize path
    log(`Calling finalizeDuel(${duelId})...`);
    try {
      const finTx = await ownerWallet.writeContract({
        address: arenaAddr,
        abi: ARENA_ABI,
        functionName: "finalizeDuel",
        args: [duelId],
      });
      const finReceipt = await publicClient.waitForTransactionReceipt({
        hash: finTx,
      });
      log(`finalizeDuel tx=${finTx} status=${finReceipt.status} block=${finReceipt.blockNumber}`);
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? (e as { shortMessage?: string }).shortMessage ?? e.message
          : String(e);
      log(`finalizeDuel failed: ${msg}`);
      // Fall through to emergencyFinalize below
    }
  } else {
    // Callbacks didn't all arrive — stall path. Wait until emergencyFinalize
    // is unblocked (lastTurnBlock + 1000 blocks) then force-resolve.
    log(
      `Callbacks incomplete (${duelFinal.completedCallbacks}/${TOTAL_CALLBACKS}) — awaiting emergencyFinalize window...`
    );

    const emergencyBlock =
      duelFinal.lastTurnBlock + BigInt(EMERGENCY_FINALIZE_BLOCKS);

    // Poll until the emergency window opens (or overall timeout)
    const emergencyDeadline = Date.now() + 5 * 60 * 1000; // extra 5 min
    while (Date.now() < emergencyDeadline) {
      const curBlock = await publicClient.getBlockNumber();
      if (curBlock >= emergencyBlock) {
        log(`Emergency window open at block ${curBlock} (needed ${emergencyBlock})`);
        break;
      }
      log(
        `Waiting for emergencyFinalize window: ${emergencyBlock - curBlock} blocks remaining`
      );
      await sleep(POLL_INTERVAL_MS);
    }

    log(`Calling emergencyFinalize(${duelId})...`);
    try {
      const emTx = await ownerWallet.writeContract({
        address: arenaAddr,
        abi: ARENA_ABI,
        functionName: "emergencyFinalize",
        args: [duelId],
      });
      const emReceipt = await publicClient.waitForTransactionReceipt({
        hash: emTx,
      });
      log(
        `emergencyFinalize tx=${emTx} status=${emReceipt.status} block=${emReceipt.blockNumber}`
      );
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? (e as { shortMessage?: string }).shortMessage ?? e.message
          : String(e);
      log(`emergencyFinalize failed: ${msg}`);
      process.exitCode = 1;
      return;
    }
  }

  // Verify resolved
  const rawDuelPost = (await publicClient.readContract({
    address: arenaAddr,
    abi: ARENA_ABI,
    functionName: "duels",
    args: [duelId],
  })) as readonly unknown[];
  const duelPost = parseDuelTuple(rawDuelPost);

  if (duelPost.status !== 3) {
    log(
      `ERROR: Duel status=${duelPost.status} — expected 3 (Resolved). Something went wrong.`
    );
    process.exitCode = 1;
    return;
  }
  log(`Duel resolved. winnerSlot=${duelPost.winnerSlot} (0=fighterA/P1, 1=fighterB/P2)`);

  // -- Step 8: Claim winnings ------------------------------------------------
  log("--- CLAIM WINNINGS ---");

  // P1 claim
  try {
    const c1Tx = await p1Wallet.writeContract({
      address: matchmkAddr,
      abi: MATCHMAKER_ABI,
      functionName: "claimWinnings",
      args: [duelId],
    });
    const c1Receipt = await publicClient.waitForTransactionReceipt({
      hash: c1Tx,
    });
    log(`P1 claimWinnings tx=${c1Tx} status=${c1Receipt.status}`);
  } catch (e: unknown) {
    const msg =
      e instanceof Error
        ? (e as { shortMessage?: string }).shortMessage ?? e.message
        : String(e);
    log(`P1 claimWinnings failed (may be AlreadySettled): ${msg}`);
  }

  // P2 claim
  try {
    const c2Tx = await p2Wallet.writeContract({
      address: matchmkAddr,
      abi: MATCHMAKER_ABI,
      functionName: "claimWinnings",
      args: [duelId],
    });
    const c2Receipt = await publicClient.waitForTransactionReceipt({
      hash: c2Tx,
    });
    log(`P2 claimWinnings tx=${c2Tx} status=${c2Receipt.status}`);
  } catch (e: unknown) {
    const msg =
      e instanceof Error
        ? (e as { shortMessage?: string }).shortMessage ?? e.message
        : String(e);
    log(`P2 claimWinnings failed (may be AlreadySettled): ${msg}`);
  }

  // -- Step 9: Final summary -------------------------------------------------
  log("--- SUMMARY ---");

  let totalDuelsAfter = BigInt(0);
  if (historyAddr) {
    try {
      totalDuelsAfter = (await publicClient.readContract({
        address: historyAddr,
        abi: DUEL_HISTORY_ABI,
        functionName: "totalDuels",
      })) as bigint;
    } catch (_) {
      // non-fatal
    }
  }

  const winnerLabel =
    duelPost.winnerSlot === 0
      ? `P1 (fighter ${duelPost.fighterA})`
      : `P2 (fighter ${duelPost.fighterB})`;

  log(`duelId:         ${duelId}`);
  log(`winner:         ${winnerLabel} (slot ${duelPost.winnerSlot})`);
  log(`totalDuels now: ${totalDuelsAfter}`);
  log("=== daily-duel complete ===");

  process.exitCode = 0;
}

main().catch((err: unknown) => {
  const msg =
    err instanceof Error
      ? (err as { shortMessage?: string }).shortMessage ?? err.message
      : String(err);
  log(`FATAL: ${msg}`);
  process.exitCode = 1;
});
