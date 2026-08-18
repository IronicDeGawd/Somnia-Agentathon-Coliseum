import { parseAbi } from 'viem';

export const CONTRACT_ADDRESSES = {
  // Router split (deploy block 461199047). Arena is now one address made of a
  // router that holds the storage and the funds plus four parts reached by
  // delegatecall — it no longer fit under the 24576-byte contract limit as a
  // single contract. None of that is visible here: the address, the function
  // signatures and the events are unchanged, and every event is still emitted
  // from the Arena address below.
  //
  // Arena also accepts a third market set, the event-contract desks, so a fight
  // can run on dreamDEX prediction windows instead of spot pools.
  //
  // Bookmaker and Matchmaker hold Arena immutable, so all four redeployed
  // together. FighterRegistry is reused (personas are live-editable via
  // setPrompt).
  //
  // Arena is linked against a deployed ArenaUtils library
  // (0x1fd61d6cf1a414ac329b0af692a61b33dab940ee). Parts, as rewired for one-shot
  // Reactivity ticks on 2026-08-18:
  //   ArenaVaultPart 0xdd09ae5c9d1cc923e4ec22b7385b3d8313d5c12a
  //   ArenaDuelPart  0x63605f9dc2fc95b2065df5847e74c09fb3e97e7e
  //   ArenaTurnPart  0x380e678126dcb60823d7085add70835fe53d63a3
  //   ArenaViewPart  0x27cabce1f4308282070dbc76e253ebe592a478af
  // The router's address never moves, so nothing here changes when parts do.
  Arena: '0x301d9364BDb2fd76E33c13eBE8FCc956BAcfbeD6' as const,
  // Redeployed 2026-08-18 for one-shot Reactivity ticks. Unlike Arena it is an
  // ordinary contract with no swappable parts, so new code means a new address.
  // Predecessors, both fully settled and drained before being left behind:
  //   0xea808eac9798e2eda1a937d3d2be8541258e3802  (pre-Reactivity)
  //   0x976f627041100dd09c1b0fe57599c0d4c15e46b5  (cancelled the live line's tick
  //                                                when settling an older duel)
  Bookmaker: '0x73d0a884f563c454ca0d05bd09b0643c0204b755' as const,
  FighterRegistry: '0xefe3dd01c59b435bb688135f19db364ef09e90df' as const,
  USDso: '0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171' as const,
  Matchmaker: '0x6b7e255a3420c7846a15e963589ffd5504773b0a' as const,
  SwapFallback: '0x7c42d20f694ba89ae0fcd6d951841e99133db487' as `0x${string}`,
  DuelHistory: '0x11Ac9B65b05dfb1406618Bda649b410B8e8F7108' as `0x${string}`,
};

/**
 * `Duel.winnerSlot` value meaning neither fighter won. Mirrors
 * ArenaTypes.DRAW_SLOT; 0 and 1 are the two slots, 255 is "unset until resolved".
 *
 * Not a rare case: both fighters are funded with identical deposits, so any duel
 * where neither trades ends exactly level.
 */
export const DRAW_SLOT = 2;

/** Registry index reported for the winner of a drawn duel — nobody. */
export const NO_WINNER_FIGHTER = 255;

/** True once DuelHistory has a real (non-zero) deployed address. */
export const DUEL_HISTORY_DEPLOYED =
  CONTRACT_ADDRESSES.DuelHistory.toLowerCase() !==
  '0x0000000000000000000000000000000000000000';

/**
 * Block at which the core contracts (Arena/Bookmaker) were deployed on Somnia
 * (deployments/somnia.json `block`). Used as the lower bound for getLogs so we
 * never ask a public RPC to scan from genesis — that gets rejected/throttled.
 */
export const BOOKMAKER_DEPLOY_BLOCK = BigInt(461199047);

/**
 * Active dreamDEX pools the Arena trades on, keyed by the poolMask bit.
 * `bit` matches ArenaTypes (WETH 0x01, WBTC 0x02, SOMI 0x04); `decimals` is the
 * base-token decimals used to value holdings (value = quote + base*mark/10^dec).
 * A duel's active pools = those whose bit is set in duels().poolMask.
 */
export const POOLS = [
  { key: 'WETH', address: '0xD180195da5459C7a0DEA188ed61216ec43682b50' as `0x${string}`, bit: 0x01, decimals: 18 },
  { key: 'WBTC', address: '0x3605f28aA7C50e7441211e77Cb0762d49539326C' as `0x${string}`, bit: 0x02, decimals: 8 },
  { key: 'SOMI', address: '0x259fD6559214dd5aD3752322426eA9F9fABEFff4' as `0x${string}`, bit: 0x04, decimals: 18 },
] as const;

/**
 * The SOMI/USDso pool, which doubles as the STT→USDso on-ramp (native STT is the
 * pool's "SOMI" base). Derived from POOLS so a pool redeploy is a one-line edit
 * above rather than a hunt for copies — see deployments/somnia.json `poolSomi`.
 */
export const SOMI_POOL = POOLS.find((p) => p.key === 'SOMI')!.address;

/**
 * Simulated-market pools (MockSpotPool) fed by scripts/sim-market.ts. All three
 * are registered on-chain with 18-decimal base (setSimPools([18,18,18])), so the
 * WBTC entry uses 18 here — unlike the real WBTC pool, which is 8-decimal.
 */
export const SIM_POOLS = [
  { key: 'WETH', address: '0x3eefa7384f046532eee8bb0acd3057fc8abc1c08' as `0x${string}`, bit: 0x01, decimals: 18 },
  { key: 'WBTC', address: '0x41525ddda51d7b82fddf7b4ec478dcddb1922a95' as `0x${string}`, bit: 0x02, decimals: 18 },
  { key: 'SOMI', address: '0xbbfd95bb70085dea83488668eeceffb2e2e1f86f' as `0x${string}`, bit: 0x04, decimals: 18 },
] as const;

/** Simulated market is live (sim pools deployed + seeded, injector running). */
export const SIM_MARKET_ENABLED = true;

/**
 * Returns the correct pool list for a given duel: real market or simulated.
 *
 * DO NOT use this to decide which markets a FIGHT trades. `simulated` is
 * two-valued — practice or not — so a spot fight and an events fight both report
 * false and both land on the real spot table. Events desks also move to fresh
 * addresses every few minutes, so no fixed table can name them. Read
 * `duelPoolsOf(duelId)` off the Arena instead; it returns what the fight actually
 * recorded when it started.
 *
 * Still fine for anything that is about a MARKET rather than a fight — quoting a
 * deposit, or naming the spot books on a landing page.
 */
export function POOLS_FOR(simulated: boolean): typeof POOLS | typeof SIM_POOLS {
  return simulated ? SIM_POOLS : POOLS;
}

/** Slot names in the [WETH, WBTC, SOMI] order the Arena stores and returns. */
export const POOL_SLOTS = [
  { key: 'WETH', bit: 0x01 },
  { key: 'WBTC', bit: 0x02 },
  { key: 'SOMI', bit: 0x04 },
] as const;

/**
 * Which markets a fight trades on. Mirrors ArenaTypes.MarketKind.
 *
 * Spot is the real coin books — a nine-round fight there needs about 150 USDso,
 * because one minimum WBTC order alone costs a few dollars and the deposit must
 * cover every fighter trading every round. Events fills all three slots with
 * live prediction questions instead, which brings the same fight under two.
 * Both are offered; neither replaced the other.
 *
 * The numbering is on-chain and stored in every past fight — never reorder it.
 * `Events` was called `Mixed` while it still kept the SOMI coin book in one
 * slot; the coin was dropped because it had become the expensive one.
 */
export enum MarketKind {
  Spot = 0,
  Practice = 1,
  Events = 2,
}

/**
 * The lobby menu: which round counts are offered on which market.
 *
 * Two players match only if they pick the same row, so every row is a separate
 * waiting line and adding rows thins them. Kept deliberately short for that
 * reason: events at every length, spot only where the deposit is not punishing,
 * and practice only at the two lengths the house bot actually fills — a row
 * nobody can be matched on is worse than no row at all.
 *
 * Practice is left off at three rounds on purpose: only one market trades there,
 * so both fighters face a single choice each turn and the fight converges to a
 * near-tie. It is a poor first impression, which is the one thing practice is for.
 */
export const LOBBY_MENU: ReadonlyArray<{ turns: number; market: MarketKind }> = [
  { turns: 3,  market: MarketKind.Events },
  { turns: 3,  market: MarketKind.Spot },
  { turns: 6,  market: MarketKind.Events },
  ...(SIM_MARKET_ENABLED ? [{ turns: 6, market: MarketKind.Practice }] : []),
  { turns: 9,  market: MarketKind.Events },
  { turns: 9,  market: MarketKind.Spot },
  ...(SIM_MARKET_ENABLED ? [{ turns: 9, market: MarketKind.Practice }] : []),
  { turns: 15, market: MarketKind.Events },
  { turns: 15, market: MarketKind.Spot },
];

export const MARKET_LABEL: Record<MarketKind, string> = {
  [MarketKind.Spot]: 'SPOT',
  [MarketKind.Practice]: 'PRACTICE',
  [MarketKind.Events]: 'EVENTS',
};

/** FighterAction enum (LLM returns 0..6) → label, mirrors ArenaTypes.FighterAction. */
export const FIGHTER_ACTIONS = [
  'HOLD', 'BUY WBTC', 'SELL WBTC', 'BUY WETH', 'SELL WETH', 'BUY SOMI', 'SELL SOMI',
] as const;

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
  fundsRecovered: boolean;
  winnerSlot: number;
  /** True when the duel runs on the simulated market (index 12 in duels() tuple). */
  simulated: boolean;
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
    // Solidity OMITS the uint8[2] lastAction array from the struct getter, so the
    // tuple is 13 fields: ...initialUsdsoPerFighter[9], fundsRecovered[10], winnerSlot[11], simulated[12].
    'function duels(uint256 duelId) view returns (uint8 fighterA, uint8 fighterB, address creator, uint256 startBlock, uint256 lastTurnBlock, uint16 completedCallbacks, uint16 turns, uint8 poolMask, uint8 status, uint256 initialUsdsoPerFighter, bool fundsRecovered, uint8 winnerSlot, bool simulated)',
    'function fighterBalances(address pool, uint256 duelId, uint8 fighterId) view returns (uint256 baseTokenAmount, uint256 quoteTokenAmount)',
    // Several duels run at once. activeDuelId() survives as a deprecated view
    // returning only the first, so read getActiveDuelIds() instead.
    'function activeDuelId() view returns (uint256)',
    'function getActiveDuelIds() view returns (uint256[])',
    'function duelsReadyForTurn() view returns (uint256[])',
    'function hasCapacity() view returns (bool)',
    'function maxActiveDuels() view returns (uint16)',
    'function minDepositFor(uint16 turns) view returns (uint256)',
    'function minDepositForMarket(uint16 turns, bool simulated) view returns (uint256)',
    'function minDepositForKind(uint16 turns, uint8 marketKind) view returns (uint256)',
    // Which questions the events market currently asks. They are re-bound between
    // fights, so the lobby reads them rather than hard-coding asset names.
    'function EVENT_POOL_WETH() view returns (address)',
    'function EVENT_POOL_WBTC() view returns (address)',
    'function EVENT_POOL_SOMI() view returns (address)',
    'function poolQuestion(address pool) view returns (bytes8)',
    // The three markets a fight is actually bound to, [WETH, WBTC, SOMI].
    // Recorded per duel at startDuel. There is no way to infer this: `simulated`
    // is two-valued (practice or not), so a spot fight and an events fight both
    // report false, and event desks move to new addresses every few minutes.
    'function duelPoolsOf(uint256 duelId) view returns (address[3])',
    // baseDecimals lives here; a desk presents 18 while a real WBTC book is 8.
    'function poolMeta(address pool) view returns (uint8 baseDecimals, uint256 minQuantity, uint256 lotSize, uint256 tickSize)',
    'function nextDuelId() view returns (uint256)',
    'function platformFee(uint16 turns) view returns (uint256)',
    'function TURN_INTERVAL_BLOCKS() view returns (uint256)',
    'function startDuelOn(uint8 fighterA, uint8 fighterB, uint16 turns, uint8 marketKind) returns (uint256)',
    'function startDuel(uint8 fighterA, uint8 fighterB, uint16 turns, bool simulated) external returns (uint256)',
    'function finalizeDuel(uint256 duelId) external',
    'function recoverFunds(uint256 duelId) external',
    // Indexing must match ArenaTypes.sol exactly: duelId and creator are indexed,
    // the fighter ids are not. Getting this wrong decodes fields into the wrong
    // slots (or drops the event) without any error.
    'event DuelStarted(uint256 indexed duelId, uint8 fighterA, uint8 fighterB, address indexed creator, uint16 turns, uint8 poolMask, uint256 startBlock)',
    'event TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber)',
    // winnerFighterId is 255 when the duel ended level — see DuelDrawn below.
    'event DuelResolved(uint256 indexed duelId, uint8 indexed winnerFighterId, uint256 valueA, uint256 valueB)',
    // Emitted alongside DuelResolved when neither fighter won, so a draw can be
    // filtered for directly instead of inferred from the 255 sentinel.
    'event DuelDrawn(uint256 indexed duelId, uint256 valueA, uint256 valueB)',
    'event FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 requestId)',
    'event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, uint8 action, uint128 orderId)',
    'event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason)',
    // The model answered with something the fighter could not execute, so the
    // turn was taken as Hold rather than burned. `requested` is the raw answer.
    'event FighterMoveCoerced(uint256 indexed duelId, uint8 indexed fighterId, string requested)',
    // The exact prompt and allowed action list for a fighter's next turn, without
    // spending an inference. Useful for showing why a fighter chose what it did.
    'function previewTurnPrompt(uint256 duelId, uint8 fighterId) view returns (string prompt, string[] allowed)',
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
    // `draws` was added with the draw migration — a tuple-shape change, so an old
    // ABI decodes this struct wrongly rather than failing loudly.
    'function getFighterRecord(uint8 index) view returns ((uint32 wins, uint32 losses, uint32 draws, uint32 duels, int256 cumulativePnl))',
    'function leaderboard() view returns ((uint32 wins, uint32 losses, uint32 draws, uint32 duels, int256 cumulativePnl)[])',
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
    'function queue(uint8 fighter, uint16 turns, uint8 marketKind) external',
    'function cancelQueue(uint16 turns, uint8 marketKind) external',
    'function triggerPendingMatch(uint16 turns, uint8 marketKind) external',
    'function claimWinnings(uint256 duelId) external',
    'function halfDeposit(uint16 turns, uint8 marketKind) view returns (uint256)',
    'function getSlot(uint16 turns, uint8 marketKind) view returns (address player, uint8 fighter, uint256 deposit, uint64 queuedAt)',
    'function arenaFree() view returns (bool)',
    'function slots(uint16 turns) view returns (address player, uint8 fighter, uint256 deposit)',
    // Matched pairs waiting for a free ring, oldest first.
    'function pendingCount(uint16 turns, uint8 marketKind) view returns (uint256)',
    'function getPendingPositions(uint16 turns, uint8 marketKind) view returns (uint256[])',
    'function cancelPending(uint16 turns, uint8 marketKind, uint256 position) external',
    'function matches(uint256 duelId) view returns (address playerA, address playerB, uint256 totalPot, bool recovered, bool settledA, bool settledB)',
    'event Queued(address indexed player, uint8 indexed fighter, uint16 turns, uint256 deposit)',
    'event QueueCancelled(address indexed player, uint16 turns, uint256 refund)',
    'event MatchPending(address indexed playerA, address indexed playerB, uint16 turns)',
    'event PendingCancelled(uint256 indexed position, address playerA, address playerB, uint16 turns)',
    'event MatchStarted(uint256 indexed duelId, address indexed playerA, address indexed playerB, uint8 fighterA, uint8 fighterB, uint16 turns)',
    'event WinningsClaimed(uint256 indexed duelId, address indexed player, uint256 amount)',
  ]),
};
