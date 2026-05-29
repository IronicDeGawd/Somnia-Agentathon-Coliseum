'use client';

import { useWatchContractEvent } from 'wagmi';
import { ABIS, CONTRACT_ADDRESSES } from '@/lib/contracts';

interface WatchEventHandlers {
  onTurnAdvanced?: (duelId: bigint, turn: number) => void;
  onDuelResolved?: (duelId: bigint, winnerSlot: number, payoutA: bigint, payoutB: bigint) => void;
  onOddsUpdated?: (duelId: bigint, degenOddsBps: number, whaleOddsBps: number) => void;
  onFighterMoveRequested?: (duelId: bigint, slot: number, prompt: string) => void;
}

export const useDuelEvents = ({
  onTurnAdvanced,
  onDuelResolved,
  onOddsUpdated,
  onFighterMoveRequested,
}: WatchEventHandlers) => {
  // Watch Arena TurnAdvanced events
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'TurnAdvanced',
    onLogs(logs) {
      for (const log of logs) {
        const { duelId, turn } = log.args;
        if (duelId !== undefined && turn !== undefined && onTurnAdvanced) {
          onTurnAdvanced(duelId, turn);
        }
      }
    },
  });

  // Watch Arena DuelResolved events
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'DuelResolved',
    onLogs(logs) {
      for (const log of logs) {
        const { duelId, winnerSlot, payoutA, payoutB } = log.args;
        if (duelId !== undefined && winnerSlot !== undefined && payoutA !== undefined && payoutB !== undefined && onDuelResolved) {
          onDuelResolved(duelId, winnerSlot, payoutA, payoutB);
        }
      }
    },
  });

  // Watch Bookmaker OddsUpdated events
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Bookmaker,
    abi: ABIS.Bookmaker,
    eventName: 'OddsUpdated',
    onLogs(logs) {
      for (const log of logs) {
        const { duelId, degenOddsBps, whaleOddsBps } = log.args;
        if (duelId !== undefined && degenOddsBps !== undefined && whaleOddsBps !== undefined && onOddsUpdated) {
          onOddsUpdated(duelId, degenOddsBps, whaleOddsBps);
        }
      }
    },
  });

  // Watch Arena FighterMoveRequested events
  useWatchContractEvent({
    address: CONTRACT_ADDRESSES.Arena,
    abi: ABIS.Arena,
    eventName: 'FighterMoveRequested',
    onLogs(logs) {
      for (const log of logs) {
        const { duelId, slot, prompt } = log.args;
        if (duelId !== undefined && slot !== undefined && prompt !== undefined && onFighterMoveRequested) {
          onFighterMoveRequested(duelId, slot, prompt);
        }
      }
    },
  });
};
