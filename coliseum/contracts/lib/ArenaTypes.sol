// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArenaTypes
/// @notice All shared data types, errors, and events for the Arena system.
///         Auditors: start here to understand the full data model.
library ArenaTypes {

    // ─── Enums ───────────────────────────────────────────────────────────────

    enum DuelStatus { None, Active, Finalizing, Resolved }

    /// @notice Actions an LLM fighter can take each turn.
    ///         The LLM returns a number 0–6 which maps to this enum.
    enum FighterAction { Hold, BuyWBTC, SellWBTC, BuyWETH, SellWETH, BuySOMI, SellSOMI }

    // ─── Turn tiers ──────────────────────────────────────────────────────────

    /// @notice Pool participation bitmask per tier.
    ///         Bit 0 = WETH, Bit 1 = WBTC, Bit 2 = SOMI.
    ///
    ///  3 turns  → SOMI only        (0x04)  cheapest entry, ~$1–2 min deposit
    ///  6 turns  → SOMI + WETH      (0x05)  mid tier,       ~$15 min deposit
    ///  9 turns  → all three        (0x07)  serious,        ~$90 min deposit
    /// 15 turns  → all three        (0x07)  marathon,       ~$143 min deposit
    uint8 internal constant POOL_BIT_WETH = 0x01;
    uint8 internal constant POOL_BIT_WBTC = 0x02;
    uint8 internal constant POOL_BIT_SOMI = 0x04;

    uint8 internal constant TIER_3_MASK  = POOL_BIT_SOMI;
    uint8 internal constant TIER_6_MASK  = POOL_BIT_SOMI | POOL_BIT_WETH;
    uint8 internal constant TIER_9_MASK  = POOL_BIT_SOMI | POOL_BIT_WETH | POOL_BIT_WBTC;
    uint8 internal constant TIER_15_MASK = POOL_BIT_SOMI | POOL_BIT_WETH | POOL_BIT_WBTC;

    // ─── Structs ─────────────────────────────────────────────────────────────

    struct Duel {
        uint8       fighterA;
        uint8       fighterB;
        address     creator;          // address that deposited — may recover funds after resolution
        uint256     startBlock;
        uint256     lastTurnBlock;
        uint16      completedCallbacks;
        uint16      turns;            // chosen at duel start: 3, 6, 9, or 15
        uint8       poolMask;         // active pool bitmask derived from turns tier
        DuelStatus  status;
        uint256     initialUsdsoPerFighter;
        uint8[2]    lastAction;       // last FighterAction per fighter (0=Hold initially)
        bool        fundsRecovered;   // true once creator has called recoverFunds
        uint8       winnerSlot;       // 0=fighterA slot won, 1=fighterB slot won, 255=unset
    }

    struct PoolBalance {
        uint256 baseTokenAmount;
        uint256 quoteTokenAmount;
    }

    /// @notice Per-pool ABI metadata cached at construction.
    struct PoolMeta {
        uint8   baseDecimals;
        uint256 minQuantity;
        uint256 lotSize;
        uint256 tickSize;
    }

    struct PendingTurn {
        uint256 duelId;
        uint8   fighterId;
        uint256 deadline;
        bool    exists;
    }

    // ─── Errors ──────────────────────────────────────────────────────────────

    error NotOwner();
    error ZeroAmount();
    error TransferFailed();
    error ApproveFailed();
    error InvalidPool(address pool);
    error InvalidExpiry();
    error BadOrderType();
    error OnlyPlatform();
    error UnknownRequest();
    error NotYetExpired();
    error InsufficientStt();
    error DuelAlreadyActive();
    error DuelNotActive();
    error DuelNotReadyToFinalize();
    error InvalidFighterPair();
    error ReactivityUnderfunded();
    error InvalidTurnCount();        // turns not in {3, 6, 9, 15}
    error DepositTooLow(uint256 required, uint256 provided);
    error NotDuelCreator();
    error DuelNotResolved();
    error NothingToRecover();
    error AlreadyRecovered();
    error CannotSweepUSDso();

    // ─── Events ──────────────────────────────────────────────────────────────

    event DuelStarted(
        uint256 indexed duelId,
        uint8   fighterA,
        uint8   fighterB,
        address indexed creator,
        uint16  turns,
        uint8   poolMask,
        uint256 startBlock
    );
    event DuelResolved(
        uint256 indexed duelId,
        uint8   indexed winnerId,
        uint256 fighterAValueUsdso,
        uint256 fighterBValueUsdso
    );
    event TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber);
    event FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 indexed requestId);
    event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, FighterAction action, uint128 orderId);
    event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason);
    event OrderPlaced(
        address indexed pool,
        uint8   indexed fighterId,
        uint256 duelId,
        uint128 orderId,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint8   orderType
    );
    event OrderRejected(
        address indexed pool,
        uint8   indexed fighterId,
        uint256 duelId,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint8   orderType,
        string  reason
    );
    event PoolsFunded(uint256 usdsoPerPool, uint256 totalDeposited);
    event VaultWithdrawn(address indexed pool, address indexed token, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event NativeWithdrawn(address indexed to, uint256 amount);
    event Resubscribed(uint256 indexed newSubscriptionId);
    event SubscriptionSkipped(string reason);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event SeedWithdrawn(address indexed to, uint256 amount);
    event DuelFundsRecovered(uint256 indexed duelId, address indexed creator, uint256 amount);
    /// @notice Emitted when an active pool has zero mark price at finalize time.
    ///         Indicates the duel result for that asset is unreliable (no liquidity).
    event DuelDegenerate(uint256 indexed duelId, address indexed pool, string reason);
    /// @notice Mark price snapshot recorded at the end of each turn. Used by
    ///         emergencyFinalize to prevent owner-timed price manipulation.
    event MarkPriceSnapshot(uint256 indexed duelId, address indexed pool, uint256 markPrice, uint16 turnNum);
}
