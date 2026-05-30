'use client';

import { defineChain } from 'viem';
import { http } from 'wagmi';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

// Custom Somnia Shannon testnet chain
export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Shannon Testnet',
  nativeCurrency: { name: 'Somnia Token', symbol: 'STT', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://api.infra.testnet.somnia.network'] },
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
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '6af78a1e30c8055287399862f108dc91';

export const config = getDefaultConfig({
  appName: 'Coliseum',
  projectId: WC_PROJECT_ID,
  chains: [somniaTestnet],
  transports: {
    [somniaTestnet.id]: http(),
  },
  // ssr:false so getDefaultConfig runs EIP-6963 multi-injected discovery on the
  // CLIENT at config creation. With ssr:true the config is first built on the
  // server (no window, no EIP-6963), and RainbowKit's curated MetaMask entry
  // then falls back to generic window.ethereum — which, when Brave/Phantom are
  // also installed, is NOT MetaMask, so MetaMask silently fails to connect.
  // The whole app is client-rendered, so SSR of wallet state buys nothing.
  ssr: false,
});
