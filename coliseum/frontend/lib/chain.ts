'use client';

import { defineChain } from 'viem';
import { http, createConfig } from 'wagmi';
import { injected } from 'wagmi/connectors';

// Define the custom Somnia Shannon testnet chain
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

// Configure Wagmi
export const config = createConfig({
  chains: [somniaTestnet],
  connectors: [injected()],
  transports: {
    [somniaTestnet.id]: http(),
  },
});
