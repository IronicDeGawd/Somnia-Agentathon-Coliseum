// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArenaTypes
/// @notice All shared data types, errors, and events for the Arena system.
///         Auditors: start here to understand the full data model.
library ArenaTypes {

    // ─── Enums ───────────────────────────────────────────────────────────────

    enum DuelStatus { None, Active, Finalizing, Resolved }

    /// @notice `Duel.winnerSlot` value meaning neither fighter won.
    ///
    ///         A tie is not a curiosity here: both fighters are funded with exactly
    ///         the same deposit, so any duel where both end up holding only their
    ///         untouched cash — every turn Hold, or every trade coerced to Hold —
    ///         ends in an exact-wei tie. Awarding that to Player 1, as the previous
    ///         `valueA >= valueB` did, took real money from Player 2 for nothing.
    ///
    ///         0 and 1 are the two slots; 255 stays "unset until resolved".
    uint8 internal constant DRAW_SLOT = 2;

    /// @notice Actions an LLM fighter can take each turn.
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

    /// @notice Which set of markets a fight trades on.
    ///
    ///         `Spot` is the real coin books. `Events` fills all three slots with
    ///         live prediction questions, which is what takes a nine-round fight
    ///         from about 150 USDso to under two. `Practice` is the mock books.
    ///
    ///         The two real kinds coexist rather than replace each other: every
    ///         fight records its own three markets at the start, so a spot fight
    ///         and an events fight run side by side without touching each other.
    ///
    /// @dev    Numbering is deliberate. The old flag was `bool simulated`, and
    ///         false/true land on Spot/Practice, so every stored value and every
    ///         caller that has not been updated still means what it used to.
    ///         NEVER reorder: the value is stored in every past fight.
    ///
    ///         `Events` was named `Mixed` while it still kept the SOMI coin book
    ///         in one slot. The coin was dropped because on this market it had
    ///         become the expensive leg — a smallest coin order costs about nine
    ///         cents against a third of a cent for a question — so the mix was
    ///         99% coin by cost. Nothing about a coin is traded there any more.
    ///
    ///         `Perps` fills all three slots with dreamDEX perpetual futures. It is
    ///         the answer to the two problems the other real markets have: a perp
    ///         position is MARGINED rather than bought, so a real asset costs a
    ///         fraction of its face where a smallest Bitcoin purchase costs $64; and
    ///         nothing ever expires, so none of the rebinding machinery a prediction
    ///         window needs applies. Fighters may bet a market DOWN here, which no
    ///         other market allows, and are scored on account equity rather than
    ///         cash-plus-holdings.
    ///
    ///         Appended LAST and never reordered, for the same reason as the others:
    ///         the value is stored in every past fight.
    enum MarketKind { Spot, Practice, Events, Perps }

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
        // Appended LAST so the duels() auto-getter only GAINS a trailing field
        // (index 12) — every existing 0..11 tuple reader keeps working untouched.
        bool        simulated;        // true = duel runs on the simulated mock pools
    }

    struct PoolBalance {
        uint256 baseTokenAmount;
        uint256 quoteTokenAmount;
    }

    /// @notice Per-pool ABI metadata cached at construction.
    /// @dev DO NOT add fields. Arena's router is deployed once and kept at its
    ///      address while its parts are replaced, so the router's bytecode holds
    ///      the auto-generated `poolMeta` getter compiled against THIS shape. A new
    ///      field would make the live getter return fewer values than every
    ///      consumer's description promises, and every read of it would fail to
    ///      decode. Per-pool additions go in their own appended mapping instead —
    ///      see `poolLabel` in ArenaStorage.
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
    /// @notice Every concurrent-duel slot is taken. `active` duels are running,
    ///         `max` is the current `maxActiveDuels` setting.
    error ArenaFull(uint256 active, uint256 max);
    error BadMaxActiveDuels();
    error DuelNotActive();
    error DuelNotReadyToFinalize();
    error InvalidFighterPair();
    error ReactivityUnderfunded();
    error InvalidTurnCount();        // turns not in {3, 6, 9, 15}
    error InvalidMarketKind();       // not one of Spot, Practice, Events, Perps

    /// @notice A perps fight was asked for before the desks were registered.
    error PerpRegistryUnset();
    /// @notice Fewer than three perp markets could be priced, were two-sided, and
    ///         fit the tier's budget — so there is no three-slot fight to run.
    ///         Reverting is deliberate: starting one anyway would give both fighters
    ///         a dead slot they are offered and cannot trade.
    error NotEnoughPerpMarkets(uint256 found);
    error DepositTooLow(uint256 required, uint256 provided);
    error NotDuelCreator();
    error DuelNotResolved();
    error NothingToRecover();
    error AlreadyRecovered();
    error CannotSweepUSDso();

    /// @notice A call arrived for a function no part has claimed. Reverting is
    ///         deliberate: an unrouted selector must never look like a success.
    error NoPart(bytes4 selector);
    /// @notice Parts may only be rewired while nothing is at stake — no duel
    ///         running and no deposit escrowed — so the rules of a fight already
    ///         underway cannot be changed and money in flight cannot be touched.
    error ArenaNotEmpty();
    /// @notice Refuses a part address with no code. A delegatecall to an address
    ///         holding no code SUCCEEDS and returns nothing, so wiring a selector
    ///         to a plain wallet by mistake would silently answer every call with
    ///         empty data instead of failing.
    error PartHasNoCode(address part);

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
    /// @param winnerId registry index of the winning fighter, or 255 on a draw.
    ///        Every resolution emits this event, draw included, so a consumer that
    ///        watches only this one never misses a duel ending.
    event DuelResolved(
        uint256 indexed duelId,
        uint8   indexed winnerId,
        uint256 fighterAValueUsdso,
        uint256 fighterBValueUsdso
    );
    /// @notice Emitted alongside DuelResolved when the duel ended level, so a draw
    ///         can be filtered for directly rather than inferred from a sentinel.
    event DuelDrawn(uint256 indexed duelId, uint256 fighterAValueUsdso, uint256 fighterBValueUsdso);
    event TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber);
    event FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 indexed requestId);
    event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, FighterAction action, uint128 orderId);
    event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason);
    /// @notice The model answered with something the fighter could not execute, so
    ///         the turn was taken as Hold instead of being burned. `requested` is the
    ///         raw answer, kept so a coercion can be told apart from a genuine Hold.
    event FighterMoveCoerced(uint256 indexed duelId, uint8 indexed fighterId, string requested);
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

    /// @notice A one-shot tick was booked for `targetBlock`. subscriptionId is zero
    ///         when the precompile refused, which is the only visible sign that the
    ///         chain of ticks has stopped.
    event TickArmed(uint64 targetBlock, uint256 subscriptionId);
    event TickCancelled(uint256 subscriptionId);
    event ReactivityDisabled();
    /// @notice The entry fee left for the pot that buys the fighters' thinking.
    ///         Absent means it stayed here as accrued fees — the fallback.
    event FeeRouted(address indexed pot, uint256 amount);
    /// @notice A held asset was sold back to cash when a fight ended.
    event AssetSettled(uint256 indexed duelId, address indexed pool, uint256 quantity, uint256 proceeds);
    /// @notice Why an asset was NOT sold at the end of a fight. Never fatal — a
    ///         fight must finish whatever the market does.
    event AssetSettleSkipped(uint256 indexed duelId, address indexed pool, string reason);

    /// @notice House surplus moved out, for an upgrade or a migration.
    event SurplusMigrated(address indexed to, uint256 amount);

    event FeesWithdrawn(address indexed to, uint256 amount);
    event SeedWithdrawn(address indexed to, uint256 amount);
    event DuelFundsRecovered(uint256 indexed duelId, address indexed creator, uint256 amount);
    /// @notice Emitted when an active pool has zero mark price at finalize time.
    ///         Indicates the duel result for that asset is unreliable (no liquidity).
    event DuelDegenerate(uint256 indexed duelId, address indexed pool, string reason);
    /// @notice Mark price snapshot recorded at the end of each turn. Used by
    ///         emergencyFinalize to prevent owner-timed price manipulation.
    event MarkPriceSnapshot(uint256 indexed duelId, address indexed pool, uint256 markPrice, uint16 turnNum);
    /// @notice The owner changed how many duels may run at once.
    event MaxActiveDuelsSet(uint16 maxActiveDuels);

    /// @notice A function was pointed at a part. Emitted once per selector so the
    ///         full routing table can be rebuilt from logs.
    event PartSet(bytes4 indexed selector, address indexed part);

    /// @notice The event-contract pool set was pointed at new addresses. Emitted
    ///         on every registration because prediction windows are short-lived
    ///         and the current set is otherwise only visible by polling.
    event EventDesksSet(address weth, address wbtc, address somi);

    // ─── Perps ───────────────────────────────────────────────────────────────

    /// @notice The permanent perp desks and their account registry were wired.
    ///         Emitted once in normal operation, unlike EventDesksSet — a perp market
    ///         does not expire, so there is nothing to re-point.
    event PerpDesksSet(address registry, address[] desks);

    /// @notice Which three of the registered markets this fight was given, decided
    ///         at duel start from what the tier's budget could actually afford.
    ///         Recorded because the set is computed rather than configured, so it is
    ///         otherwise unreconstructable after the fact — the effective margin
    ///         factor that excluded a market will have moved on by then.
    event PerpMarketsSelected(uint256 indexed duelId, address[3] desks, uint256 budget);

    /// @notice A fighter was given its own trading address and funded.
    event PerpAccountLeased(uint256 indexed duelId, uint8 indexed fighterId, address indexed account, uint256 budget);

    /// @notice A fighter's positions were closed and its collateral taken back.
    ///         `clean` false means the account could not be flattened and has been
    ///         quarantined for retry — the fight still resolved.
    event PerpAccountReleased(uint256 indexed duelId, uint8 indexed fighterId, uint256 reclaimed, bool clean);

    /// @notice A fighter's score, read as account equity. Negative is possible and
    ///         means the fighter was liquidated into a deficit; it counts as zero.
    event PerpFighterScored(uint256 indexed duelId, uint8 indexed fighterId, int256 equity, bool live);
}
