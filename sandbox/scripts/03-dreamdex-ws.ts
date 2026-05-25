/**
 * Test 3 — dreamDEX WebSocket feed
 *
 * Validates all 4 WS channels the Arena screen uses:
 *   orderbook  → live bid/ask for WETH/USDso
 *   trades     → recent fills
 *   ohlcv      → 1m candle stream
 *   order      → (skipped — needs a live order ID, tested separately)
 *
 * Connects, subscribes to first 3 channels, waits for 1 message each,
 * then disconnects cleanly.
 *
 * Run: npm run test:ws
 * No env vars needed (public WS, no auth).
 *
 * Confirmed testnet WS host: wss://stg.api.dreamdex.io/v0/ws/public
 */

import WebSocket from "ws";
import "dotenv/config";

const WS_URL = process.env.DREAMDEX_WS ?? "wss://stg.api.dreamdex.io/v0/ws/public";
const SYMBOL = "WETH-USDso";
const TIMEOUT_MS = 30_000;

interface WsMessage {
  channel?: string;
  data?: unknown;
  error?: string;
}

async function waitForMessage(
  ws: WebSocket,
  channel: string,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: no message on channel '${channel}' within ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        if (msg.channel === channel && msg.data !== undefined) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg.data);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.on("message", handler);
  });
}

function send(ws: WebSocket, payload: object) {
  ws.send(JSON.stringify(payload));
}

async function main() {
  console.log("Connecting to dreamDEX testnet WS:", WS_URL, "\n");

  const ws = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
  });
  console.log("✅ Connected\n");

  // Heartbeat — keep alive every 15s
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { operation: "ping" });
    }
  }, 15_000);

  ws.on("message", (raw) => {
    try {
      const msg: WsMessage = JSON.parse(raw.toString());
      if (msg.error) {
        console.error("WS error message:", msg.error);
      }
    } catch {}
  });

  try {
    // --- Channel 1: orderbook ---
    console.log("=== Channel: orderbook ===");
    send(ws, { operation: "subscribe", channel: "orderbook", symbols: [SYMBOL] });
    const book = await waitForMessage(ws, "orderbook", TIMEOUT_MS);
    const bookAny = book as any;
    console.log("✅ Received orderbook snapshot");
    if (bookAny?.bids?.length > 0) {
      console.log("  Best bid:", bookAny.bids[0]);
    }
    if (bookAny?.asks?.length > 0) {
      console.log("  Best ask:", bookAny.asks[0]);
    }

    // --- Channel 2: trades ---
    console.log("\n=== Channel: trades ===");
    send(ws, { operation: "subscribe", channel: "trades", symbols: [SYMBOL], limit: 5 });
    const trades = await waitForMessage(ws, "trades", TIMEOUT_MS);
    const tradesAny = trades as any;
    console.log("✅ Received trades");
    if (Array.isArray(tradesAny) && tradesAny.length > 0) {
      console.log("  Latest trade:", tradesAny[0]);
    } else {
      console.log("  Data:", JSON.stringify(tradesAny).slice(0, 200));
    }

    // --- Channel 3: ohlcv ---
    console.log("\n=== Channel: ohlcv ===");
    send(ws, { operation: "subscribe", channel: "ohlcv", symbol: SYMBOL, timeframe: "1m" });
    const candle = await waitForMessage(ws, "ohlcv", TIMEOUT_MS);
    console.log("✅ Received ohlcv candle:", JSON.stringify(candle).slice(0, 200));

    console.log("\n✅ All 3 WS channels verified");
    console.log("   orderbook ✅  trades ✅  ohlcv ✅");
    console.log("   'order' channel skipped — needs live order ID (tested in test:dreamdex)");

  } finally {
    clearInterval(heartbeat);
    ws.close();
    console.log("\nDisconnected cleanly.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
