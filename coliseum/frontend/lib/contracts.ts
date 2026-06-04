import { parseAbi } from 'viem';

export const CONTRACT_ADDRESSES = {
  Arena: '0x2f38647596cda697f8fd674430cb4c9b31eb6a1b' as const,
  Bookmaker: '0xdf5709661a3f16f4ef3ee8cc232a087f016dbf7f' as const,
  FighterRegistry: '0x5390b0656797b18258f2919a799abe956d21690f' as const,
  USDso: '0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171' as const,
  Matchmaker: '0x92ddaca48f65586e9d8c117ae4252813e120a157' as const,
  SwapFallback: '0x7c42d20f694ba89ae0fcd6d951841e99133db487' as `0x${string}`,
  // Set on the Arena redeploy that wires setDuelHistory (see context/plan/leaderboard-history.md).
  // Zero until then — leaderboard/history hooks detect this and render honest empty states.
  DuelHistory: '0x0000000000000000000000000000000000000000' as `0x${string}`,
};

/** True once DuelHistory has a real (non-zero) deployed address. */
export const DUEL_HISTORY_DEPLOYED =
  CONTRACT_ADDRESSES.DuelHistory.toLowerCase() !==
  '0x0000000000000000000000000000000000000000';

/**
 * Block at which the core contracts (Arena/Bookmaker) were deployed on Somnia
 * (deployments/somnia.json `block`). Used as the lower bound for getLogs so we
 * never ask a public RPC to scan from genesis — that gets rejected/throttled.
 */
export const BOOKMAKER_DEPLOY_BLOCK = BigInt(394572942);

export enum DuelStatus {
  None = 0,
  Active = 1,
  Finalizing = 2,
  Resolved = 3,
}

export interface DuelData {
  fighterA: number;
  fighterB: number;
  creator: `0x${string}`;
  startBlock: bigint;
  lastTurnBlock: bigint;
  completedCallbacks: number;
  turns: number;
  poolMask: number;
  status: DuelStatus;
  initialUsdsoPerFighter: bigint;
  lastAction: [number, number];
  fundsRecovered: boolean;
  winnerSlot: number;
}

export interface FighterData {
  name: string;
  tagline: string;
  systemPrompt: string;
  aggression: number;
  patience: number;
  risk: number;
}

export interface BetData {
  bettor: `0x${string}`;
  fighterId: number;
  stake: bigint;
  oddsAtPlacementBps: number;
  settled: boolean;
}

export interface OddsData {
  oddsA: number;
  oddsB: number;
}

export const ABIS = {
  Arena: parseAbi([
    'function duels(uint256 duelId) view returns (uint8 fighterA, uint8 fighterB, address creator, uint256 startBlock, uint256 lastTurnBlock, uint16 completedCallbacks, uint16 turns, uint8 poolMask, uint8 status, uint256 initialUsdsoPerFighter, uint8[2] lastAction, bool fundsRecovered, uint8 winnerSlot)',
    'function activeDuelId() view returns (uint256)',
    'function minDepositFor(uint16 turns) view returns (uint256)',
    'function nextDuelId() view returns (uint256)',
    'function PLATFORM_FEE() view returns (uint256)',
    'function TURN_INTERVAL_BLOCKS() view returns (uint256)',
    'function startDuel(uint8 fighterA, uint8 fighterB, uint16 turns) external returns (uint256)',
    'function finalizeDuel(uint256 duelId) external',
    'function recoverFunds(uint256 duelId) external',
    'event DuelStarted(uint256 indexed duelId, uint8 indexed fighterA, uint8 indexed fighterB, address creator, uint16 turns, uint8 poolMask, uint256 startBlock)',
    'event TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber)',
    'event DuelResolved(uint256 indexed duelId, uint8 indexed winnerFighterId, uint256 valueA, uint256 valueB)',
    'event FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 requestId)',
    'event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)',
    'event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason)',
    'event DuelFundsRecovered(uint256 indexed duelId, address indexed creator, uint256 amount)',
    'event MarkPriceSnapshot(uint256 indexed duelId, address indexed pool, uint256 markPrice, uint16 turnNum)',
    'event DuelDegenerate(uint256 indexed duelId, address indexed pool, string reason)',
    'event OrderPlaced(address indexed pool, uint8 indexed fighterId, uint256 indexed duelId, uint128 orderId, bool isBid, uint256 price, uint256 quantity, uint8 orderType)',
    'event OrderRejected(address indexed pool, uint8 indexed fighterId, uint256 indexed duelId, bool isBid, uint256 price, uint256 quantity, uint8 orderType, string reason)',
  ]),

  Bookmaker: parseAbi([
    'function currentOdds(uint256 duelId, uint256 index) view returns (uint16)',
    'function bets(uint256 duelId, uint256 index) view returns (address bettor, uint8 fighterId, uint256 stake, uint16 oddsAtPlacementBps, bool settled)',
    'function duelSettled(uint256 duelId) view returns (bool)',
    'function rakeAccrued(uint256 duelId) view returns (uint256)',
    'function pendingOddsRequest(uint256 duelId) view returns (bool)',
    'function lastOddsUpdateBlock(uint256 duelId) view returns (uint256)',
    'function placeBet(uint256 duelId, uint8 fighterId, uint256 stake) external',
    'function settleBets(uint256 duelId) external',
    'function initializeOdds(uint256 duelId, uint16 oddsA, uint16 oddsB) external',
    'function updateOdds(uint256 duelId, uint16 oddsA, uint16 oddsB) external',
    'event OddsInitialized(uint256 indexed duelId, uint16 oddsA, uint16 oddsB)',
    'event OddsUpdated(uint256 indexed duelId, uint16 oddsA, uint16 oddsB)',
    'event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex)',
    'event BetsSettled(uint256 indexed duelId, uint8 indexed winnerId, uint256 totalPayout, uint256 rake)',
    'event RakeWithdrawn(uint256 indexed duelId, address indexed to, uint256 amount)',
    'event OddsRequestSent(uint256 indexed duelId, uint256 indexed requestId, uint256 blockNumber)',
    'event OddsRequestFailed(uint256 indexed duelId, string reason)',
  ]),

  DuelHistory: parseAbi([
    'function getFighterRecord(uint8 index) view returns ((uint32 wins, uint32 losses, uint32 duels, int256 cumulativePnl))',
    'function leaderboard() view returns ((uint32 wins, uint32 losses, uint32 duels, int256 cumulativePnl)[])',
    'function totalDuels() view returns (uint256)',
    'function getEntries(uint256 offset, uint256 limit) view returns ((uint256 duelId, uint8 fighterA, uint8 fighterB, uint8 winnerSlot, uint8 winnerFighter, uint256 valueA, uint256 valueB, int256 pnlA, int256 pnlB, uint64 blockNumber)[])',
    'function getFighterEntries(uint8 index, uint256 offset, uint256 limit) view returns ((uint256 duelId, uint8 fighterA, uint8 fighterB, uint8 winnerSlot, uint8 winnerFighter, uint256 valueA, uint256 valueB, int256 pnlA, int256 pnlB, uint64 blockNumber)[])',
    'function fighterEntryCount(uint8 index) view returns (uint256)',
    'function recorded(uint256 duelId) view returns (bool)',
    'event DuelRecorded(uint256 indexed duelId, uint8 indexed winnerFighter, uint8 fighterA, uint8 fighterB, int256 pnlA, int256 pnlB)',
  ]),

  FighterRegistry: parseAbi([
    'function fighters(uint8 index) view returns (string name, string tagline, string systemPrompt, uint8 aggression, uint8 patience, uint8 risk)',
    'function getFighter(uint8 id) view returns (string name, string tagline, string systemPrompt, uint8 aggression, uint8 patience, uint8 risk)',
    'function FIGHTER_COUNT() view returns (uint8)',
  ]),

  USDso: parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ]),

  Matchmaker: parseAbi([
    'function queue(uint8 fighter, uint16 turns) external',
    'function cancelQueue(uint16 turns) external',
    'function triggerPendingMatch() external',
    'function claimWinnings(uint256 duelId) external',
    'function halfDeposit(uint16 turns) view returns (uint256)',
    'function getSlot(uint16 turns) view returns (address player, uint8 fighter, uint256 deposit)',
    'function arenaFree() view returns (bool)',
    'function slots(uint16 turns) view returns (address player, uint8 fighter, uint256 deposit)',
    'function pending() view returns (address playerA, address playerB, uint8 fighterA, uint8 fighterB, uint16 turns, uint256 totalPot, bool exists)',
    'function matches(uint256 duelId) view returns (address playerA, address playerB, uint256 totalPot, bool recovered, bool settledA, bool settledB)',
    'event Queued(address indexed player, uint8 indexed fighter, uint16 turns, uint256 deposit)',
    'event QueueCancelled(address indexed player, uint16 turns, uint256 refund)',
    'event MatchPending(address indexed playerA, address indexed playerB, uint16 turns)',
    'event MatchStarted(uint256 indexed duelId, address indexed playerA, address indexed playerB, uint8 fighterA, uint8 fighterB, uint16 turns)',
    'event WinningsClaimed(uint256 indexed duelId, address indexed player, uint256 amount)',
  ]),
};
