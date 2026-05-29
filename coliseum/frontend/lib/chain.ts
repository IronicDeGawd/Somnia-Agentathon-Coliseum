'use client';

import { defineChain } from 'viem';
import { http } from 'wagmi';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

// Custom Somnia Shannon testnet chain
export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Shannon Testnet',
  nativeCurrency: {
    name: 'Somnia Token',
    symbol: 'STT',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://api.infra.testnet.somnia.network'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Somnia Shannon Explorer',
      url: 'https://explorer-v2.testnet.somnia.network',
    },
  },
  testnet: true,
});

// RainbowKit config. A WalletConnect projectId is required for the
// WalletConnect/mobile options; injected wallets (MetaMask, Rabby, etc.)
// work without it. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID for full support.
export const config = getDefaultConfig({
  appName: 'Coliseum',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'coliseum_testnet_demo',
  chains: [somniaTestnet],
  transports: {
    [somniaTestnet.id]: http(),
  },
  ssr: true,
});
