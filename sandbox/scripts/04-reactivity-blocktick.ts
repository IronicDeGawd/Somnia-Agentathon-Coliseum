/**
 * Test 4 — Reactivity BlockTick (off-chain WebSocket subscription)
 *
 * Subscribes to the Somnia Reactivity precompile's BlockTick system event.
 * BlockTick fires on every block (~10/sec on Somnia testnet).
 * We wait for 3 ticks to confirm the subscription is live, then unsubscribe.
 *
 * This is the exact mechanism that will drive Arena.turn() in Coliseum.
 *
 * Key gotchas (from forge-test-report.md):
 *   - SDK constructor needs WebSocket-backed public client (not HTTP)
 *   - eventContractSources is plural, Address[] (not singular)
 *   - subscribe() returns Promise<Result | Error> — must check instanceof Error
 *   - Topic hash = keccak256('BlockTick(uint64)') WITHOUT 'indexed' keyword
 *   - Precompile address: 0x0000000000000000000000000000000000000100
 *
 * Run: npm run test:reactivity
 * Env: PRIVATE_KEY required (SDK wallet client), RPC_WS optional
 */

import { createPublicClient, createWalletClient, webSocket, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SDK } from "@somnia-chain/reactivity";
import "dotenv/config";

// Reactivity requires the dream-rpc WS endpoint, not the standard infra WS
const RPC_WS = process.env.RPC_WS ?? "wss://dream-rpc.somnia.network/ws";
const RPC_HTTP = process.env.RPC_HTTP ?? "https://api.infra.testnet.somnia.network";

// Somnia testnet chain definition
const somniaTestnet = {
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_HTTP], webSocket: [RPC_WS] },
    public: { http: [RPC_HTTP], webSocket: [RPC_WS] },
  },
} as const;

// Precompile address (padded to 20 bytes)
const REACTIVITY_PRECOMPILE = "0x0000000000000000000000000000000000000100" as `0x${string}`;

// Topic hash for BlockTick(uint64) — keccak256 without 'indexed' keyword
const BLOCKTICK_TOPIC = keccak256(toHex("BlockTick(uint64)")) as `0x${string}`;

const TICKS_WANTED = 3;
const TIMEOUT_MS = 60_000;

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set in .env");

  const account = privateKeyToAccount(pk as `0x${string}`);
  console.log("Wallet:", account.address);

  // SDK requires WebSocket-backed public client
  const wsPublicClient = createPublicClient({
    chain: somniaTestnet,
    transport: webSocket(RPC_WS),
  });

  const walletClient = createWalletClient({
    account,
    chain: somniaTestnet,
    transport: http(RPC_HTTP),
  });

  // Check balance
  const httpPublicClient = createPublicClient({ chain: somniaTestnet, transport: http(RPC_HTTP) });
  const balance = await httpPublicClient.getBalance({ address: account.address });
  console.log("Balance:", Number(balance) / 1e18, "STT\n");

  if (balance === 0n) {
    throw new Error("Wallet has 0 STT — get testnet tokens from the faucet first");
  }

  // Instantiate Reactivity SDK
  const sdk = new SDK({ public: wsPublicClient, wallet: walletClient });

  console.log("Subscribing to BlockTick via Reactivity SDK...");
  console.log("  Precompile:", REACTIVITY_PRECOMPILE);
  console.log("  Topic:", BLOCKTICK_TOPIC);
  console.log(`  Waiting for ${TICKS_WANTED} ticks (timeout ${TIMEOUT_MS / 1000}s)\n`);

  let tickCount = 0;
  let subscription: { subscriptionId: `0x${string}`; unsubscribe: () => Promise<any> } | null = null;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: received only ${tickCount}/${TICKS_WANTED} ticks`));
    }, TIMEOUT_MS);

    sdk.subscribe({
      ethCalls: [],
      eventContractSources: [REACTIVITY_PRECOMPILE],
      topicOverrides: [BLOCKTICK_TOPIC],
      onData: (data) => {
        tickCount++;
        const topics = data.result.topics;
        const blockHex = topics[1] ?? "0x0";
        const blockNum = BigInt(blockHex);
        console.log(`  Tick #${tickCount} — block ${blockNum.toString()}`);
        if (tickCount >= TICKS_WANTED) {
          clearTimeout(timer);
          resolve();
        }
      },
      onError: (err: unknown) => {
        clearTimeout(timer);
        // ErrorEvent: dump all fields so we can see the root cause
        console.error("onError raw:", JSON.stringify(err, Object.getOwnPropertyNames(err as object)));
        const msg = (err as any)?.message ?? (err as any)?.error?.message ?? String(err);
        reject(new Error("Reactivity onError: " + msg));
      },
    }).then((sub) => {
      if (sub instanceof Error) {
        clearTimeout(timer);
        reject(sub);
        return;
      }
      subscription = sub;
      console.log("  Subscription ID:", sub.subscriptionId);
    }).catch((err: unknown) => {
      clearTimeout(timer);
      console.error("subscribe() rejected — type:", typeof err, Object.prototype.toString.call(err));
      console.error("  keys:", Object.getOwnPropertyNames(err as object));
      console.error("  JSON:", JSON.stringify(err, Object.getOwnPropertyNames(err as object)));
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  await done;

  // Unsubscribe cleanly
  if (subscription) {
    await (subscription as any).unsubscribe();
    console.log("\nUnsubscribed.");
  }

  console.log(`\n✅ Reactivity BlockTick verified — received ${tickCount} ticks`);
  console.log("   This confirms the turn-loop mechanism for Coliseum will work.");

  // Give the WS time to close gracefully
  await new Promise((r) => setTimeout(r, 1_000));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
