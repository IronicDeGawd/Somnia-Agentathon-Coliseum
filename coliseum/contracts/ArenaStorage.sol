// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/ArenaTypes.sol";
import "./interfaces/IFighterRegistry.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/ISomniaReactivityPrecompile.sol";

/// @title ArenaStorage
/// @notice The single declaration of everything Arena remembers.
///
///         Arena is being split into a router that holds the funds and several
///         parts reached by delegatecall, because one contract can no longer fit
///         under the 24576-byte deploy limit. Delegatecall runs a part's code
///         against the ROUTER's storage, so every part must agree, slot for slot,
///         on where each value lives. The only way to guarantee that is to
///         declare it exactly once, here, and have the router and every part
///         inherit this and declare no state of their own.
///
///         Rules for changing this file:
///           - APPEND new variables at the end. Never reorder, never delete.
///           - No part may add state. If a part needs to remember something, it
///             belongs here.
///           - Nothing here may be `immutable`. An immutable is compiled into the
///             bytecode of the contract that declares it, so a part reached by
///             delegatecall would read its OWN copy — blank, because parts are
///             deployed without meaningful constructor arguments. The five values
///             that used to be immutable (USDSO, the three real pools, the
///             platform address, the registry) are ordinary storage for exactly
///             this reason.
abstract contract ArenaStorage {

    // ─── Constants ────────────────────────────────────────────────────────────
    // Constants occupy no storage slot; they are compiled into whichever code
    // reads them. They live here so every part shares one definition.

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant REACTIVITY_FUND_MIN = 33 ether;

    /// @notice Platform fee scales with duel length to track LLM inference cost,
    ///         which grows with turns (≈0.24 STT/move × 2 fighters × turns). Flat
    ///         fees over-charge short duels and under-charge long ones, so the fee
    ///         is hybrid: fee = base + perTurn × turns (18-decimal USDso).
    ///         e.g. turns=3 → 0.8, turns=6 → 1.1, turns=9 → 1.4, turns=15 → 2.0.
    uint256 public constant PLATFORM_FEE_BASE     = 0.5e18;
    uint256 public constant PLATFORM_FEE_PER_TURN = 0.1e18;

    uint64  public constant MAX_EXPIRE_OFFSET_SEC          = 7 days;
    uint256 public constant LLM_AGENT_ID                   = 12847293847561029384;
    uint256 public constant FIGHTER_DEPOSIT_TOPUP          = 0.07 ether;
    uint256 public constant FIGHTER_REQUEST_DEADLINE_SEC   = 15 minutes;

    /// @notice If no turn has advanced for this many blocks, owner may call emergencyFinalize.
    uint256 public constant EMERGENCY_FINALIZE_BLOCKS = 1000;

    /// @notice Hard ceiling on maxActiveDuels. Each running duel burns STT on two
    ///         inferences per turn out of one shared balance, so the owner is not
    ///         free to raise the cap arbitrarily — a dry Arena silently produces
    ///         all-Hold duels, which now resolve as draws.
    uint16 public constant MAX_ACTIVE_CEILING = 8;

    /// @notice The reactivity handler's selector, needed when subscribing. Held as
    ///         a constant rather than read off the function, because the part that
    ///         subscribes does not declare onEvent — the router does.
    bytes4 internal constant ON_EVENT_SELECTOR = bytes4(keccak256("onEvent(address,bytes32[],bytes)"));

    // ─── Deployment wiring ────────────────────────────────────────────────────
    // Set once at construction. Ordinary storage rather than immutable — see the
    // contract-level note above.

    address public USDSO;
    address public POOL_WETH;
    address public POOL_WBTC;
    address public POOL_SOMI;
    address public PLATFORM_ADDR;
    IFighterRegistry public registry;
    uint256 public TURN_INTERVAL_BLOCKS;

    // ─── Vault state ──────────────────────────────────────────────────────────

    // Simulated market pool set — owner-set post-deploy (address(0) until then).
    // Duels created with simulated == true route here instead of the real pools.
    address public SIM_POOL_WETH;
    address public SIM_POOL_WBTC;
    address public SIM_POOL_SOMI;
    bool    public simPoolsSet;
    address public owner;
    uint256 public subscriptionId;
    uint256 public accruedFees;

    /// @notice Sum of all un-recovered duel pots currently escrowed in this
    ///         contract's USDso balance. withdrawFees() never dips below this, so
    ///         platform-fee withdrawal can never touch depositor principal.
    ///         Incremented in startDuel, decremented in recoverFunds.
    uint256 public escrowedPot;

    /// @notice Running total of USDso the OWNER has seeded into pool vaults via
    ///         fundPools(). Tracked separately from user duel deposits so the
    ///         owner can withdraw their own seed liquidity without touching
    ///         depositor funds. Incremented in fundPools, decremented in
    ///         ownerWithdrawSeed.
    uint256 public seedLiquidity;

    mapping(address => ArenaTypes.PoolMeta) public poolMeta;

    // ─── Duel state ───────────────────────────────────────────────────────────

    mapping(uint256 => ArenaTypes.Duel) public duels;
    uint256 public nextDuelId = 1;

    /// @notice Every duel currently running. Order is not stable — _resolveDuel
    ///         removes by swap-and-pop, so the last id takes the resolved one's place.
    ///         Read it through getActiveDuelIds() — kept internal so solc does not
    ///         also emit a per-index auto-getter, which Arena has no room for.
    uint256[] internal activeDuelIds;

    /// @dev duelId → index+1 in activeDuelIds (0 = not active), for O(1) removal.
    mapping(uint256 => uint256) internal _activeIndex;

    /// @notice How many duels may run at once. Owner-settable up to MAX_ACTIVE_CEILING.
    uint16 public maxActiveDuels = 3;

    /// @notice USDso escrow held for each duel's creator (the pot, fee excluded).
    ///         Set on startDuel, paid out (and zeroed) on recoverFunds. recoverFunds
    ///         pays the creator from this contract's OWN balance, capped by duelPot,
    ///         so one duel can never drain another's deposit or the owner seed.
    mapping(uint256 => uint256) public duelPot;

    /// @notice The three pools a duel trades on, recorded once at startDuel.
    ///         Previously derived from duel.simulated against two hard-coded sets,
    ///         which cannot express a pool set that only exists for one duel (an
    ///         event window opens at a fresh address every few minutes). Recording
    ///         per duel also closes audit item M1: a pool's cached trading rules can
    ///         be refreshed without a redeploy, and running duels keep the set they
    ///         started on. Order is [WETH, WBTC, SOMI] to match the bit ordering.
    mapping(uint256 => address[3]) internal duelPools;

    // poolAddress → duelId → fighterId → balance
    mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) public fighterBalances;

    mapping(uint256 => ArenaTypes.PendingTurn) public pendingTurns;  // requestId → turn

    /// @notice Mark price snapshot per duel per pool, written at the start of each turn.
    ///         emergencyFinalize uses this instead of live prices to prevent owner-timed
    ///         price manipulation. Normal finalizeDuel still uses live prices (safe because
    ///         all callbacks are complete — no further trading can move the book).
    mapping(uint256 => mapping(address => uint256)) public duelMarkSnapshots;

    /// @notice Previous-turn mark price per duel/pool. Carried forward from
    ///         duelMarkSnapshots before each turn's snapshot overwrites it, so the
    ///         market summary handed to fighters can show the move since last turn.
    mapping(uint256 => mapping(address => uint256)) public duelPrevMarkSnapshots;

    /// @notice Optional history sink. When set, _resolveDuel records each duel's
    ///         outcome here (best-effort). Configured post-deploy via setDuelHistory.
    address public duelHistory;

    /// @notice Which part answers each function. The router looks a call's
    ///         selector up here and hands the work to that part, which runs
    ///         against this contract's storage. Public so the wiring is auditable
    ///         from outside without replaying logs.
    mapping(bytes4 => address) public partOf;

    /// @notice The event-contract pool set, in the same [WETH, WBTC, SOMI] order.
    ///         These are normally EventDesk adapters standing in front of a
    ///         dreamDEX prediction market, but any slot may hold an ordinary spot
    ///         pool — Arena only cares that the address answers a pool's questions.
    ///
    ///         Unlike the real and simulated sets, this one is expected to be
    ///         re-registered often: a prediction window opens at a fresh address
    ///         every few minutes. That is safe because each duel records its own
    ///         pool set at the start, so re-pointing this never disturbs a fight
    ///         already underway.
    address public EVENT_POOL_WETH;
    address public EVENT_POOL_WBTC;
    address public EVENT_POOL_SOMI;
    bool    public eventPoolsSet;

    /// @notice The question a slot asks, in a few characters and with no spaces
    ///         ("BTCUP"). Empty means the address is an ordinary asset, which is
    ///         what every spot pool is and what an unlabelled slot stays.
    ///
    ///         A prediction contract's mark is a probability between zero and one,
    ///         not a price, so a labelled pool is described to fighters in odds and
    ///         its trades read as backing or dropping the question. The label
    ///         becomes part of the action name the model answers with.
    ///
    ///         Deliberately its own mapping rather than a field on PoolMeta: the
    ///         router is never redeployed, so its compiled `poolMeta` getter cannot
    ///         grow. Appending here changes no existing slot. Read it through
    ///         ArenaViewPart, since the router has no getter for it either.
    mapping(address => bytes8) internal poolLabel;

    /// @notice Whether turns are allowed to arm a Reactivity subscription at all.
    ///         Deliberately explicit rather than inferred from subscriptionId: a
    ///         one-shot subscription is expected to be absent most of the time, so
    ///         "no subscription" cannot mean "switched off".
    ///
    ///         Internal, like poolLabel, because the router's getters are frozen.
    ///         Read it through ArenaViewPart.reactivityStatus().
    bool internal reactivityOn;

    /// @notice The block number currently named in the live subscription's topic.
    ///         Zero means nothing is armed. Compared before re-arming so an
    ///         already-correct subscription is left alone instead of being paid for
    ///         twice.
    uint64 internal armedForBlock;

    // ─── Shared behaviour ─────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert ArenaTypes.NotOwner();
        _;
    }

    /// @notice Turn-scaled platform fee collected at startDuel. Pure, and read by
    ///         Matchmaker before it quotes a player, so it stays reachable directly.
    function platformFee(uint16 turns) public pure returns (uint256) {
        return PLATFORM_FEE_BASE + PLATFORM_FEE_PER_TURN * uint256(turns);
    }

    /// @notice The pool set a duel is bound to. Kept as a function rather than a
    ///         bare mapping read so the three-slot load is emitted once instead of
    ///         at every call site — Arena has no room for the inlined copies.
    function _duelPools(uint256 duelId) internal view returns (address[3] memory) {
        return duelPools[duelId];
    }

    /// @notice Resolve a pool set from the real/simulated flag alone. Only correct
    ///         where no duel exists yet — quoting a deposit before one is created.
    ///         Anything holding a duel must use _duelPools instead.
    ///         Returned order is [WETH, WBTC, SOMI] to match the bit ordering.
    function _pools(bool simulated) internal view returns (address[3] memory) {
        if (simulated) return [SIM_POOL_WETH, SIM_POOL_WBTC, SIM_POOL_SOMI];
        return [POOL_WETH, POOL_WBTC, POOL_SOMI];
    }

    /// @notice The same, for the three-way market choice. Reverts if the chosen
    ///         set was never registered, rather than quietly starting a fight on
    ///         three zero addresses that can never be traded.
    function _poolsFor(ArenaTypes.MarketKind kind) internal view returns (address[3] memory) {
        if (kind == ArenaTypes.MarketKind.Practice) {
            if (!simPoolsSet) revert ArenaTypes.InvalidPool(address(0));
            return [SIM_POOL_WETH, SIM_POOL_WBTC, SIM_POOL_SOMI];
        }
        if (kind == ArenaTypes.MarketKind.Events) {
            if (!eventPoolsSet) revert ArenaTypes.InvalidPool(address(0));
            return [EVENT_POOL_WETH, EVENT_POOL_WBTC, EVENT_POOL_SOMI];
        }
        return [POOL_WETH, POOL_WBTC, POOL_SOMI];
    }

    /// @notice Reject any pool address Arena was never told about. Trading and
    ///         vault withdrawal both gate on this, so an arbitrary address can
    ///         never be handed a token approval or an order.
    function _requireValidPool(address pool) internal view {
        if (pool != POOL_WETH && pool != POOL_WBTC && pool != POOL_SOMI
            && pool != SIM_POOL_WETH && pool != SIM_POOL_WBTC && pool != SIM_POOL_SOMI
            && pool != EVENT_POOL_WETH && pool != EVENT_POOL_WBTC && pool != EVENT_POOL_SOMI)
            revert ArenaTypes.InvalidPool(pool);
    }

    /// @notice The registered event-contract set, [WETH, WBTC, SOMI].
    function _eventPools() internal view returns (address[3] memory) {
        return [EVENT_POOL_WETH, EVENT_POOL_WBTC, EVENT_POOL_SOMI];
    }

    /// @notice Record a pool's trading rules — tick, minimum size, lot size and
    ///         base-token decimals — so order math does not re-read them on every
    ///         trade. A pool that cannot answer is cached with permissive defaults
    ///         rather than reverting, so one bad pool cannot block a deployment.
    ///
    ///         Lives here because both the router's constructor and the part that
    ///         registers new pool sets need it.
    ///         Leaves the pool's question label alone, so refreshing a desk's
    ///         trading rules cannot silently turn it back into a plain asset and
    ///         start describing odds as a price.
    function _cachePoolMeta(address pool, uint8 baseDecimals) internal {
        try ISpotPool(pool).getPoolParams() returns (
            address, address, uint256, uint256,
            uint256 tickSize, uint256 minQty, uint256 lotSize
        ) {
            poolMeta[pool] = ArenaTypes.PoolMeta({
                baseDecimals: baseDecimals,
                minQuantity:  minQty,
                lotSize:      lotSize,
                tickSize:     tickSize
            });
        } catch {
            poolMeta[pool] = ArenaTypes.PoolMeta({
                baseDecimals: baseDecimals,
                minQuantity:  0,
                lotSize:      1,
                tickSize:     1
            });
        }
    }

    /// @param label the question in a few characters for an event desk, or empty to
    ///        return the slot to being an ordinary asset.
    function _cachePoolMeta(address pool, uint8 baseDecimals, bytes8 label) internal {
        _cachePoolMeta(pool, baseDecimals);
        poolLabel[pool] = label;
    }

    // ─── Reactivity: one subscription, aimed at the next turn ─────────────────
    //
    // A BlockTick subscription with a zero in eventTopics[1] fires on EVERY block —
    // ~10.5 times a second, measured at ~31 STT/hour whether a fight was running or
    // the arena was empty. A turn happens once per TURN_INTERVAL_BLOCKS, so all but
    // one of those firings did nothing but return.
    //
    // Put a block NUMBER in that field and it fires once, at that block: measured
    // 4/4 hops landing on the exact block, 0 blocks late, 0.0045 STT per firing
    // including booking the next one. Per 15-round fight that is 0.07 STT against
    // 7.8 STT polled.
    //
    // The cost of that shape is that it does not self-heal. Each firing is what
    // books the next one, so a firing that never lands ends the chain silently,
    // where an every-block subscription simply retries 100 ms later. The keeper bot
    // therefore stays, as a watchdog: it advances a turn that is overdue by more
    // than its grace period, and re-arms when it does.

    /// @notice The earliest block at which any running duel is due a turn, or zero
    ///         if no duel needs one. A duel already past due arms for the next block
    ///         rather than a block in the past, which would never fire.
    function _nextTurnBlock() internal view returns (uint64) {
        uint256 best = 0;
        uint256[] memory ids = activeDuelIds;
        for (uint256 i = 0; i < ids.length; i++) {
            ArenaTypes.Duel storage d = duels[ids[i]];
            if (d.status != ArenaTypes.DuelStatus.Active) continue;
            if (d.completedCallbacks >= d.turns * 2) continue;
            uint256 due = d.lastTurnBlock + TURN_INTERVAL_BLOCKS;
            if (due <= block.number) due = block.number + 1;
            if (best == 0 || due < best) best = due;
        }
        return uint64(best);
    }

    /// @notice Point the single subscription at whichever duel is due soonest.
    ///         No-op while reactivity is off, and no-op when the subscription
    ///         already names the right block — re-arming for the same block would
    ///         pay the 210,000-gas creation cost for nothing.
    function _scheduleNextTick() internal {
        if (!reactivityOn) return;
        uint64 target = _nextTurnBlock();
        if (target == 0) {
            _cancelTick();
            return;
        }
        if (target == armedForBlock && subscriptionId != 0) return;
        if (subscriptionId != 0) _unsubscribeReactivity(subscriptionId);
        uint256 newId = _subscribeReactivity(target);
        subscriptionId = newId;
        // A failed subscribe leaves nothing armed, so the next caller retries
        // instead of believing a tick is booked that never was.
        armedForBlock  = newId == 0 ? 0 : target;
        emit ArenaTypes.TickArmed(target, newId);
    }

    /// @notice Stop paying for ticks. Safe to call when nothing is armed.
    function _cancelTick() internal {
        uint256 id = subscriptionId;
        if (id != 0) _unsubscribeReactivity(id);
        subscriptionId = 0;
        armedForBlock  = 0;
        if (id != 0) emit ArenaTypes.TickCancelled(id);
    }

    /// @notice Ask the precompile for one firing at `targetBlock`.
    ///         A zero return means the precompile refused or is absent — locally the
    ///         address holds no code, and a call to a codeless address SUCCEEDS with
    ///         empty return data, which is why the empty-return branch exists.
    function _subscribeReactivity(uint64 targetBlock) internal returns (uint256 newId) {
        ISomniaReactivityPrecompile.SubscriptionData memory data = ISomniaReactivityPrecompile.SubscriptionData({
            eventTopics: [
                keccak256("BlockTick(uint64)"),
                // The whole point of the change. A zero here means every block.
                bytes32(uint256(targetBlock)),
                bytes32(0),
                bytes32(0)
            ],
            origin:                  address(0),
            caller:                  address(0),
            emitter:                 SOMNIA_REACTIVITY_PRECOMPILE,
            handlerContractAddress:  address(this),
            handlerFunctionSelector: ON_EVENT_SELECTOR,
            // Priority fee must be high enough to win the per-block reactivity queue.
            // Testnet baseFee is ~6 gwei; lower-priority subs get indefinitely deferred
            // even though the subscription stays alive. That matters MORE with one shot:
            // a deferred firing is not a late turn, it is the end of the chain.
            priorityFeePerGas:       10_000_000_000,
            // maxFeePerGas must be >= priorityFeePerGas + baseFee.
            maxFeePerGas:            50_000_000_000,
            // Arena _runTurn does pool snapshots + 2 LLM createRequest calls, and now
            // also books the next tick (210,000 gas). 3M gas was tight; reactive txs
            // were silently failing out-of-gas with no event. 15M, under the 200M cap.
            gasLimit:                15_000_000,
            isGuaranteed:            false,
            isCoalesced:             false
        });

        (bool ok, bytes memory ret) = SOMNIA_REACTIVITY_PRECOMPILE.call(
            abi.encodeWithSelector(ISomniaReactivityPrecompile.subscribe.selector, data)
        );
        if (ok && ret.length >= 32) {
            newId = abi.decode(ret, (uint256));
        } else {
            newId = 0;
            emit ArenaTypes.SubscriptionSkipped("precompile unavailable");
        }
    }

    /// @dev Best-effort. A failed cancel must never revert the turn or the
    ///      resolution that triggered it — worst case a subscription outlives its
    ///      block, which costs one firing, not a stuck fight.
    function _unsubscribeReactivity(uint256 id) internal {
        (bool ok, ) = SOMNIA_REACTIVITY_PRECOMPILE.call(
            abi.encodeWithSelector(ISomniaReactivityPrecompile.unsubscribe.selector, id)
        );
        if (!ok) emit ArenaTypes.SubscriptionSkipped("unsubscribe failed");
    }
}
