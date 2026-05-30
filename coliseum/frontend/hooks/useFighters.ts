'use client';

import { useReadContracts } from 'wagmi';
import { CONTRACT_ADDRESSES, ABIS } from '@/lib/contracts';

export interface FighterData {
  index: number;
  name: string;
  tagline: string;
  systemPrompt: string;
  aggression: number;
  patience: number;
  risk: number;
  hex: string;
  side: 'a' | 'b';
  dicebearSeed: string;
}

const FIGHTER_COUNT = 6;

const VISUAL_IDENTITY: Record<number, { hex: string; side: 'a' | 'b'; dicebearSeed: string }> = {
  0: { hex: '#ff3366', side: 'a', dicebearSeed: 'degen-fury-9' },
  1: { hex: '#00d9ff', side: 'b', dicebearSeed: 'whale-deep-22' },
  2: { hex: '#a78bfa', side: 'a', dicebearSeed: 'quant-sigma-5' },
  3: { hex: '#fcd34d', side: 'b', dicebearSeed: 'diamond-hand-hold-3' },
  4: { hex: '#f97316', side: 'a', dicebearSeed: 'scalper-edge-12' },
  5: { hex: '#34d399', side: 'b', dicebearSeed: 'contrarian-rev-5' },
};

const FIGHTER_REGISTRY_ABI = [
  ...ABIS.FighterRegistry ?? [],
  {
    name: 'getFighter',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'id', type: 'uint8' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'tagline', type: 'string' },
          { name: 'systemPrompt', type: 'string' },
          { name: 'aggression', type: 'uint8' },
          { name: 'patience', type: 'uint8' },
          { name: 'risk', type: 'uint8' },
        ],
      },
    ],
  },
];

const getFighterAbi = [
  {
    name: 'getFighter',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'id', type: 'uint8' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'tagline', type: 'string' },
          { name: 'systemPrompt', type: 'string' },
          { name: 'aggression', type: 'uint8' },
          { name: 'patience', type: 'uint8' },
          { name: 'risk', type: 'uint8' },
        ],
      },
    ],
  },
] as const;

type FighterTuple = {
  name: string;
  tagline: string;
  systemPrompt: string;
  aggression: number;
  patience: number;
  risk: number;
};

export function useFighters(): { fighters: FighterData[]; isLoading: boolean } {
  const contracts = Array.from({ length: FIGHTER_COUNT }, (_, i) => ({
    address: CONTRACT_ADDRESSES.FighterRegistry,
    abi: getFighterAbi,
    functionName: 'getFighter' as const,
    args: [i] as [number],
  }));

  const { data, isLoading } = useReadContracts({ contracts });

  const fighters: FighterData[] = [];

  if (data) {
    for (let i = 0; i < FIGHTER_COUNT; i++) {
      const result = data[i];
      if (result?.status === 'success' && result.result) {
        const raw = result.result as unknown as FighterTuple;
        const visual = VISUAL_IDENTITY[i] ?? { hex: '#ffffff', side: 'a' as const, dicebearSeed: `fighter-${i}` };
        fighters.push({
          index: i,
          name: raw.name,
          tagline: raw.tagline,
          systemPrompt: raw.systemPrompt,
          aggression: Number(raw.aggression),
          patience: Number(raw.patience),
          risk: Number(raw.risk),
          hex: visual.hex,
          side: visual.side,
          dicebearSeed: visual.dicebearSeed,
        });
      }
    }
  }

  return { fighters, isLoading };
}

export function useFighter(index: number): { fighter: FighterData | null; isLoading: boolean } {
  const { fighters, isLoading } = useFighters();
  const fighter = fighters.find((f) => f.index === index) ?? null;
  return { fighter, isLoading };
}
