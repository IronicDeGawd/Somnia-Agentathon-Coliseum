'use client';

import { defineChain, http, fallback } from 'viem';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

// Public Somnia testnet RPCs. dream-rpc is the canonical endpoint; api.infra is
// the fallback. Both send permissive CORS headers, but each throttles a browser
// firing many reads at once — so we batch (below) and fail over between them.
const RPC_PRIMARY  = 'https://dream-rpc.somnia.network';
const RPC_FALLBACK = 'https://api.infra.testnet.somnia.network';

// Custom Somnia Shannon testnet chain
export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Shannon Testnet',
  nativeCurrency: { name: 'Somnia Token', symbol: 'STT', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_PRIMARY, RPC_FALLBACK] },
  },
  blockExplorers: {
    default: {
      name: 'Somnia Shannon Explorer',
      url: 'https://explorer-v2.testnet.somnia.network',
    },
  },
  testnet: true,
});

// WalletConnect Cloud project id — client-side, NOT a secret (it's baked into
// the client bundle by design). Shared across the SomniaForge workspace; rotate
// via cloud.reown.com. Env override wins; the shared id is the fallback so the
// full wallet list (Rainbow, MetaMask, WalletConnect QR, Coinbase) works
// out of the box.
const WC_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'aa06fae24033614abcb0a99765157d71';

export const config = getDefaultConfig({
  appName: 'Coliseum',
  projectId: WC_PROJECT_ID,
  chains: [somniaTestnet],
  transports: {
    // Batch many eth_calls into single HTTP POSTs (collapses the read burst so
    // the public RPC doesn't throttle us), and fail over to the backup RPC.
    [somniaTestnet.id]: fallback([
      http(RPC_PRIMARY,  { batch: true }),
      http(RPC_FALLBACK, { batch: true }),
    ]),
  },
  // ssr:false so getDefaultConfig runs EIP-6963 multi-injected discovery on the
  // CLIENT at config creation. With ssr:true the config is first built on the
  // server (no window, no EIP-6963), and RainbowKit's curated MetaMask entry
  // then falls back to generic window.ethereum — which, when Brave/Phantom are
  // also installed, is NOT MetaMask, so MetaMask silently fails to connect.
  // The whole app is client-rendered, so SSR of wallet state buys nothing.
  ssr: false,
});
