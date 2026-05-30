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
        const { duelId, completedCallbacks } = log.args;
        if (duelId !== undefined && completedCallbacks !== undefined && onTurnAdvanced) {
          onTurnAdvanced(duelId, completedCallbacks);
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
        const { duelId, winnerFighterId, valueA, valueB } = log.args;
        if (duelId !== undefined && winnerFighterId !== undefined && valueA !== undefined && valueB !== undefined && onDuelResolved) {
          onDuelResolved(duelId, winnerFighterId, valueA, valueB);
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
        const { duelId, oddsA, oddsB } = log.args;
        if (duelId !== undefined && oddsA !== undefined && oddsB !== undefined && onOddsUpdated) {
          onOddsUpdated(duelId, oddsA, oddsB);
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
        const { duelId, fighterId } = log.args;
        if (duelId !== undefined && fighterId !== undefined && onFighterMoveRequested) {
          onFighterMoveRequested(duelId, fighterId, '');
        }
      }
    },
  });
};
