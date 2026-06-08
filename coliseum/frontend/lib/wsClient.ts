import { createPublicClient, webSocket, type PublicClient } from 'viem';
import { somniaTestnet } from '@/lib/chain';

// Somnia testnet has a working WebSocket RPC at api.infra.testnet (NOT the
// dream-rpc host, which 502s on WS upgrade). We use a single dedicated WS
// client for all live event subscriptions (eth_subscribe), so the rest of the
// app's reads/writes stay on HTTP while events stream in real time.
const WS_RPC_URL =
  process.env.NEXT_PUBLIC_SOMNIA_WSS ?? 'wss://api.infra.testnet.somnia.network/ws';

let sharedWsClient: PublicClient | null = null;

export function getWsClient(): PublicClient | null {
  if (typeof window === 'undefined') return null; // no WS during SSR
  if (!sharedWsClient) {
    try {
      sharedWsClient = createPublicClient({
        chain: somniaTestnet,
        transport: webSocket(WS_RPC_URL, { reconnect: true }),
      });
    } catch {
      return null;
    }
  }
  return sharedWsClient;
}
