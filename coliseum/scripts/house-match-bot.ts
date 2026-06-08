/**
 * house-match-bot.ts — fallback "house" opponent for the Matchmaker.
 * ---------------------------------------------------------------------------
 * When a player queues a duel and no human is there to match, this bot fills the
 * opponent slot so the duel can start. It runs on its OWN wallet
 * (HOUSE_PRIVATE_KEY) so its txs never contend with the deployer-key watcher for
 * nonces. It only ever matches a player who is already waiting alone — it never
 * sits as the lonely slot itself (and self-cancels if it ever does).
 *
 * Matchmaker.queue() is permissionless: depositing halfDeposit and queueing a
 * DIFFERENT fighter into the waiting player's (tier, market) slot pairs them and
 * fires Arena.startDuel(). The frontend navigates on the MatchStarted event, so
 * the player's screen jumps straight into the fight.
 *
 * Honesty: this is a fallback AI house opponent so a solo visitor can still see a
 * duel — not a fake crowd. The watcher still only times turns; all moves/odds
 * are decided on-chain.
 *
 * Env (coliseum/.env):
 *   HOUSE_PRIVATE_KEY  — required, the house wallet (gen-bot-key.mjs)
 *   HOUSE_MARKETS      — "sim,real" (default) | "sim" | "real"
 *   HOUSE_TIERS        — "3,6,9,15" (default)
 *   HOUSE_GRACE_S      — seconds a player must wait alone before the house steps
 *                        in (default 15) — leaves room for a real opponent.
 *   HOUSE_TICK_MS      — poll interval (default 5000)
 *
 * Run:  pnpm exec hardhat run scripts/house-match-bot.ts --network somnia
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, defineChain,
  formatUnits, maxUint256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const somnia = defineChain({
  id: 50312,
  name: "Somnia Shannon Testnet",
  nativeCurrency: { name: "Somnia Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  testnet: true,
});

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);
const fmtU = (v: bigint) => parseFloat(formatUnits(v, 18)).toFixed(4);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const MM_ABI = [
  { name: "getSlot", type: "function", stateMutability: "view", inputs: [{ name: "turns", type: "uint16" }, { name: "simulated", type: "bool" }], outputs: [{ name: "player", type: "address" }, { name: "fighter", type: "uint8" }, { name: "deposit", type: "uint256" }, { name: "queuedBlock", type: "uint64" }] },
  { name: "halfDeposit", type: "function", stateMutability: "view", inputs: [{ name: "turns", type: "uint16" }, { name: "simulated", type: "bool" }], outputs: [{ type: "uint256" }] },
  { name: "arenaFree", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "queue", type: "function", stateMutability: "nonpayable", inputs: [{ name: "fighter", type: "uint8" }, { name: "turns", type: "uint16" }, { name: "simulated", type: "bool" }], outputs: [] },
  { name: "cancelQueue", type: "function", stateMutability: "nonpayable", inputs: [{ name: "turns", type: "uint16" }, { name: "simulated", type: "bool" }], outputs: [] },
  { name: "claimWinnings", type: "function", stateMutability: "nonpayable", inputs: [{ name: "duelId", type: "uint256" }], outputs: [] },
] as const;

const ARENA_ABI = [
  { name: "activeDuelId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // 12-field auto-getter (uint8[2] lastAction omitted); status=idx8, winnerSlot=idx11
  { name: "duels", type: "function", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [
    { type: "uint8" }, { type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
    { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { name: "status", type: "uint8" },
    { type: "uint256" }, { type: "bool" }, { name: "winnerSlot", type: "uint8" },
  ] },
] as const;

const REG_ABI = [
  { name: "FIGHTER_COUNT", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const STATUS_RESOLVED = 8; // duels() index 8 == DuelStatus.Resolved (3) — read as result[8]
const RESOLVED = 3;
const ZERO = "0x0000000000000000000000000000000000000000";

async function main() {
  const pk = process.env.HOUSE_PRIVATE_KEY;
  if (!pk) throw new Error("HOUSE_PRIVATE_KEY not set (run gen-bot-key.mjs HOUSE_PRIVATE_KEY)");

  const markets = (process.env.HOUSE_MARKETS ?? "sim,real").split(",").map((s) => s.trim().toLowerCase());
  const doSim = markets.includes("sim");
  const doReal = markets.includes("real");
  // Default to tier 3 + 6 only: real tiers 9/15 require 91/151 USDso per side,
  // beyond any demo house bankroll, so the house can't field them. Override with
  // HOUSE_TIERS if you ever fund a larger bankroll.
  const tiers = (process.env.HOUSE_TIERS ?? "3,6").split(",").map((s) => Number(s.trim()) as 3 | 6 | 9 | 15);
  const graceMs = Number(process.env.HOUSE_GRACE_S ?? "15") * 1000;
  const tickMs = Number(process.env.HOUSE_TICK_MS ?? "5000");

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somnia.json"), "utf8"));
  const addr = (v: unknown): `0x${string}` => (typeof v === "string" ? v : (v as { address: string }).address) as `0x${string}`;
  const MM = addr(manifest.contracts.Matchmaker);
  const ARENA = addr(manifest.contracts.Arena);
  const REG = addr(manifest.contracts.FighterRegistry);
  const USDSO = manifest.external.usdso as `0x${string}`;

  const account = privateKeyToAccount(pk as `0x${string}`);
  const pub = createPublicClient({ chain: somnia, transport: http() });
  const wallet = createWalletClient({ account, chain: somnia, transport: http() });
  const HOUSE = account.address;

  const fighterCount = Number(await pub.readContract({ address: REG, abi: REG_ABI, functionName: "FIGHTER_COUNT" }));

  log(`house-match-bot starting`);
  log(`  house wallet: ${HOUSE}`);
  log(`  markets: ${markets.join(",")}  tiers: ${tiers.join(",")}  grace: ${graceMs / 1000}s  tick: ${tickMs}ms`);
  log(`  Matchmaker ${MM}  Arena ${ARENA}  fighters ${fighterCount}`);
  {
    const bal = await pub.readContract({ address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [HOUSE] }) as bigint;
    const stt = await pub.getBalance({ address: HOUSE });
    log(`  bankroll: ${fmtU(bal)} USDso  ${fmtU(stt)} STT`);
  }

  const marketFlags: boolean[] = [];
  if (doSim) marketFlags.push(true);
  if (doReal) marketFlags.push(false);

  const seenAt = new Map<string, number>();      // "tier:sim" → first time a lonely player was seen
  const ourQueuedAt = new Map<string, number>(); // "tier:sim" → when WE queued (self-cancel safety)
  const started: { duelId: bigint; claimed: boolean }[] = [];

  let allowanceOk = false;

  let running = true;
  const stop = () => { log("shutting down…"); running = false; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      for (const turns of tiers) {
        for (const sim of marketFlags) {
          if (!running) break;
          const key = `${turns}:${sim ? "sim" : "real"}`;

          const slot = await pub.readContract({ address: MM, abi: MM_ABI, functionName: "getSlot", args: [turns, sim] }) as readonly [`0x${string}`, number, bigint, bigint];
          const player = slot[0];
          const slotFighter = Number(slot[1]);

          if (player === ZERO) { seenAt.delete(key); ourQueuedAt.delete(key); continue; }

          // We became the lonely slot (the human cancelled after we queued). Reclaim.
          if (player.toLowerCase() === HOUSE.toLowerCase()) {
            const since = ourQueuedAt.get(key);
            if (since && Date.now() - since > 4000) {
              log(`${key}: house is the lonely slot — cancelling to reclaim deposit`);
              try {
                const h = await wallet.writeContract({ address: MM, abi: MM_ABI, functionName: "cancelQueue", args: [turns, sim] });
                await pub.waitForTransactionReceipt({ hash: h });
              } catch (e) { log(`${key}: cancel failed: ${(e as Error).message?.slice(0, 120)}`); }
              ourQueuedAt.delete(key);
            }
            continue;
          }

          // A real player is waiting. Start the grace clock.
          const first = seenAt.get(key) ?? (seenAt.set(key, Date.now()), Date.now());
          if (Date.now() - first < graceMs) continue;
          if (!(await pub.readContract({ address: MM, abi: MM_ABI, functionName: "arenaFree" }))) continue;

          const half = await pub.readContract({ address: MM, abi: MM_ABI, functionName: "halfDeposit", args: [turns, sim] }) as bigint;
          const bal = await pub.readContract({ address: USDSO, abi: ERC20_ABI, functionName: "balanceOf", args: [HOUSE] }) as bigint;
          if (bal < half) { log(`${key}: skip — need ${fmtU(half)} USDso, house has ${fmtU(bal)} (top up to cover this tier)`); continue; }

          if (!allowanceOk) {
            const allow = await pub.readContract({ address: USDSO, abi: ERC20_ABI, functionName: "allowance", args: [HOUSE, MM] }) as bigint;
            if (allow < half) {
              log(`approving USDso → Matchmaker`);
              const h = await wallet.writeContract({ address: USDSO, abi: ERC20_ABI, functionName: "approve", args: [MM, maxUint256] });
              await pub.waitForTransactionReceipt({ hash: h });
            }
            allowanceOk = true;
          }

          // Pick a different fighter than the waiting player.
          let f = Math.floor(Math.random() * fighterCount);
          if (f === slotFighter) f = (f + 1) % fighterCount;

          log(`${key}: matching ${player.slice(0, 8)}… (their fighter ${slotFighter}) with house fighter ${f}, ${fmtU(half)} USDso`);
          try {
            const h = await wallet.writeContract({ address: MM, abi: MM_ABI, functionName: "queue", args: [f, turns, sim] });
            await pub.waitForTransactionReceipt({ hash: h });
            seenAt.delete(key);
            ourQueuedAt.set(key, Date.now());
            const duelId = await pub.readContract({ address: ARENA, abi: ARENA_ABI, functionName: "activeDuelId" }) as bigint;
            if (duelId > 0n && !started.some((s) => s.duelId === duelId)) {
              started.push({ duelId, claimed: false });
              log(`${key}: duel #${duelId} started`);
              ourQueuedAt.delete(key); // matched immediately, we are not a lonely slot
            }
          } catch (e) {
            log(`${key}: queue failed: ${(e as Error).message?.slice(0, 140)}`);
          }
        }
      }

      // Claim resolved duels we started (collects pot if house won; recovers funds
      // either way so the user can claim their win).
      for (const s of started) {
        if (s.claimed) continue;
        const d = await pub.readContract({ address: ARENA, abi: ARENA_ABI, functionName: "duels", args: [s.duelId] }) as readonly unknown[];
        if (Number(d[STATUS_RESOLVED]) !== RESOLVED) continue;
        try {
          const h = await wallet.writeContract({ address: MM, abi: MM_ABI, functionName: "claimWinnings", args: [s.duelId] });
          await pub.waitForTransactionReceipt({ hash: h });
          s.claimed = true;
          log(`duel #${s.duelId}: claimWinnings done (winnerSlot ${Number(d[11])})`);
        } catch (e) {
          // Already settled / not a player edge — mark claimed to stop retrying.
          const msg = (e as Error).message ?? "";
          if (/AlreadySettled|NotAPlayer/.test(msg)) s.claimed = true;
          else log(`duel #${s.duelId}: claim failed: ${msg.slice(0, 120)}`);
        }
      }
    } catch (e) {
      log(`loop error: ${(e as Error).message?.slice(0, 160)}`);
    }
    await sleep(tickMs);
  }

  log("house-match-bot stopped.");
}

main().catch((e) => { console.error("house-match-bot fatal:", e); process.exitCode = 1; });
