// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ArenaVault.sol";
import "./lib/ArenaTypes.sol";
import "./lib/ArenaUtils.sol";
import "./interfaces/IFighterRegistry.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/ISomniaAgents.sol";
import "./interfaces/IDuelHistory.sol";

/// @title Arena
/// @notice 1v1 AI-agent trading duel orchestrator on Somnia.
///
///  Flow:
///    1. Owner deploys + calls fundPools() to seed the dreamDEX vaults.
///    2. Any user approves USDso and calls startDuel(fighterA, fighterB, turns).
///       - turns ∈ {3, 6, 9, 15}.  Tier determines which pools are active.
///       - Deposit = minDeposit(turns) + PLATFORM_FEE, pulled from msg.sender.
///    3. Each BlockTick fires onEvent → _runTurn → two LLM inferNumber calls.
///    4. handleFighterResponse executes the chosen action on dreamDEX (FOK order).
///    5. After all turns, anyone calls finalizeDuel → DuelResolved emitted.
///    6. Duel creator calls recoverFunds(duelId) to withdraw their USDso back.
///
///  Safety:
///    - expireTurn(): owner can unblock a stuck pending LLM request after deadline.
///    - emergencyFinalize(): owner can force-resolve a duel stuck in Active state
///      after EMERGENCY_FINALIZE_BLOCKS blocks have passed since the last turn,
///      without waiting for remaining callbacks. Funds remain recoverable.
///    - recoverFunds(): duel creator can always pull their USDso back after resolution.
contract Arena is ArenaVault {

    using ArenaUtils for *;

    // ─── Constants ────────────────────────────────────────────────────────────

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

    address public immutable PLATFORM_ADDR;
    IFighterRegistry public immutable registry;
    uint256 public TURN_INTERVAL_BLOCKS;

    // ─── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => ArenaTypes.Duel) public duels;
    uint256 public nextDuelId = 1;

    /// @notice Every duel currently running. Order is not stable — _resolveDuel
    ///         removes by swap-and-pop, so the last id takes the resolved one's place.
    ///         Read it through getActiveDuelIds() — kept private so solc does not
    ///         also emit a per-index auto-getter, which Arena has no room for.
    uint256[] private activeDuelIds;

    /// @dev duelId → index+1 in activeDuelIds (0 = not active), for O(1) removal.
    mapping(uint256 => uint256) private _activeIndex;

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
    mapping(uint256 => address[3]) private duelPools;

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

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _registry,
        address _usdso,
        address _poolWeth,
        address _poolWbtc,
        address _poolSomi,
        address _platform,
        uint256 _turnIntervalBlocks,
        uint8[3] memory _baseDecimals   // [WETH, WBTC, SOMI]
    ) payable ArenaVault(_usdso, _poolWeth, _poolWbtc, _poolSomi) {
        // Reactivity is OPT-IN: call resubscribe() to switch it on.
        //
        // This used to demand 33 STT up front and subscribe in the constructor.
        // A BlockTick subscription bills every block whether or not a duel is
        // running — ~25.8 STT/hour — and the precompile offers no unsubscribe, so
        // the only way to stop one is to let the contract's balance run dry. A
        // fresh deploy therefore started burning immediately and silently. Turns
        // are keeper-driven now, so nothing here needs the subscription.
        registry            = IFighterRegistry(_registry);
        PLATFORM_ADDR       = _platform;
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;

        _cachePoolMeta(_poolWeth, _baseDecimals[0]);
        _cachePoolMeta(_poolWbtc, _baseDecimals[1]);
        _cachePoolMeta(_poolSomi, _baseDecimals[2]);
    }

    function _onEventSelector() internal pure override returns (bytes4) {
        return this.onEvent.selector;
    }

    // ─── Reactivity callback ─────────────────────────────────────────────────

    function onEvent(address /*emitter*/, bytes32[] calldata eventTopics, bytes calldata /*data*/) external {
        if (msg.sender != SOMNIA_REACTIVITY_PRECOMPILE) return;
        if (eventTopics.length < 2) return;
        uint64 blockNumber = uint64(uint256(eventTopics[1]));
        if (blockNumber % TURN_INTERVAL_BLOCKS != 0) return;
        // Advance every running duel. _runTurn is a no-op for any duel whose
        // interval has not elapsed, so this stays cheap when only one is live.
        uint256[] memory ids = activeDuelIds;
        for (uint256 i = 0; i < ids.length; i++) _runTurn(ids[i]);
    }

    /// @notice Set the DuelHistory sink (owner-only). Recording is best-effort and
    ///         never blocks resolution, so this can be set or updated at any time.
    function setDuelHistory(address h) external onlyOwner {
        duelHistory = h;
    }

    /// @notice Manual turn advance, owner-only. Reactivity `onEvent` drives turns automatically;
    ///         this is a fallback for when the subscription is down. Public access would let an
    ///         attacker time turns to sandwich pool manipulation around LLM context reads.
    function turn(uint256 duelId) external onlyOwner {
        _runTurn(duelId);
    }

    function _runTurn(uint256 duelId) internal {
        if (duelId == 0) return;
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) return;
        if (block.number < duel.lastTurnBlock + TURN_INTERVAL_BLOCKS) return;
        if (duel.completedCallbacks >= duel.turns * 2) return;
        duel.lastTurnBlock = block.number;

        // Snapshot mark prices on every active pool BEFORE any LLM requests.
        // emergencyFinalize will use these snapshots instead of live prices.
        _snapshotMarkPrices(duelId, duel);

        _requestFighterMove(duelId, duel.fighterA);
        _requestFighterMove(duelId, duel.fighterB);
        emit ArenaTypes.TurnAdvanced(duelId, duel.completedCallbacks, block.number);
    }

    /// @notice Raise or lower how many duels may run at once. Lowering below the
    ///         current count does not cancel anything — it only stops new starts
    ///         until enough resolve.
    function setMaxActiveDuels(uint16 n) external onlyOwner {
        if (n == 0 || n > MAX_ACTIVE_CEILING) revert ArenaTypes.BadMaxActiveDuels();
        maxActiveDuels = n;
        emit ArenaTypes.MaxActiveDuelsSet(n);
    }

    function _snapshotMarkPrices(uint256 duelId, ArenaTypes.Duel storage duel) internal {
        address[3] memory pools = _duelPools(duelId);
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        uint16 turnNum = duel.completedCallbacks / 2 + 1;
        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            uint256 mp = ArenaUtils.midMarkPrice(pools[i]);
            if (mp > 0) {
                // Carry the prior snapshot forward so the market summary can show
                // the move since last turn, then record this turn's price.
                duelPrevMarkSnapshots[duelId][pools[i]] = duelMarkSnapshots[duelId][pools[i]];
                duelMarkSnapshots[duelId][pools[i]] = mp;
                emit ArenaTypes.MarkPriceSnapshot(duelId, pools[i], mp, turnNum);
            }
        }
    }

    // ─── Duel lifecycle ───────────────────────────────────────────────────────

    /// @notice Start a new duel. Caller deposits the minimum required USDso + platform fee.
    /// @param fighterA  Fighter index (0–5 from FighterRegistry)
    /// @param fighterB  Fighter index (0–5, must differ from fighterA)
    /// @param turns     Duel length: 3, 6, 9, or 15
    function startDuel(
        uint8  fighterA,
        uint8  fighterB,
        uint16 turns,
        bool   simulated
    ) external returns (uint256 duelId) {
        // Duels run concurrently up to maxActiveDuels. Everything that could
        // collide between them — escrow, per-fighter balances, mark snapshots,
        // odds and bets — is already keyed by duelId, so the only shared resource
        // is this contract's STT balance for inference (see the watcher fuel guard).
        if (activeDuelIds.length >= maxActiveDuels)
            revert ArenaTypes.ArenaFull(activeDuelIds.length, maxActiveDuels);

        if (!ArenaUtils.isValidTurnCount(turns)) revert ArenaTypes.InvalidTurnCount();

        // Simulated duels can only start once the mock pool set is registered.
        if (simulated && !simPoolsSet) revert ArenaTypes.InvalidPool(address(0));

        uint8 count = registry.FIGHTER_COUNT();
        if (fighterA == fighterB || fighterA >= count || fighterB >= count)
            revert ArenaTypes.InvalidFighterPair();

        // Resolve which pool set this duel trades on (real vs simulated).
        address[3] memory mPools = _pools(simulated);

        // Compute minimum deposit for this tier and pull from caller.
        uint256 minDeposit = ArenaUtils.minDepositFor(
            turns, mPools[0], mPools[1], mPools[2], poolMeta
        );
        // If no book data (local hardhat), minDeposit is 0. Use a floor of 2 USDso per fighter
        // so the duel pot is non-zero even without live price feeds.
        if (minDeposit == 0) minDeposit = 2e18;
        // Fee scales with turns to track LLM inference cost (see platformFee).
        uint256 fee = platformFee(turns);
        uint256 required = minDeposit + fee;

        uint256 provided = IERC20Minimal(USDSO).allowance(msg.sender, address(this));
        if (provided < required) revert ArenaTypes.DepositTooLow(required, provided);

        bool ok = IERC20Minimal(USDSO).transferFrom(msg.sender, address(this), required);
        if (!ok) revert ArenaTypes.TransferFailed();

        // Platform fee stays in contract; remainder is the duel pot.
        accruedFees += fee;
        uint256 pot = required - fee;
        uint256 initialUsdsoPerFighter = pot / 2;
        if (initialUsdsoPerFighter == 0) revert ArenaTypes.ZeroAmount();

        uint8 mask = ArenaUtils.poolMaskForTurns(turns);

        duelId = nextDuelId++;
        duels[duelId] = ArenaTypes.Duel({
            fighterA:                fighterA,
            fighterB:                fighterB,
            creator:                 msg.sender,
            startBlock:              block.number,
            lastTurnBlock:           block.number,
            completedCallbacks:      0,
            turns:                   turns,
            poolMask:                mask,
            status:                  ArenaTypes.DuelStatus.Active,
            initialUsdsoPerFighter:  initialUsdsoPerFighter,
            lastAction:              [uint8(0), uint8(0)],
            fundsRecovered:          false,
            winnerSlot:              type(uint8).max, // 255 = unset until resolved
            simulated:               simulated
        });
        activeDuelIds.push(duelId);
        _activeIndex[duelId] = activeDuelIds.length; // index+1; 0 means "not active"

        // Freeze this duel's pool set. Every later read goes through here, so a
        // duel keeps the markets it started on even if the registered sets change.
        duelPools[duelId] = mPools;

        // Escrow the real pot in this contract's USDso balance. recoverFunds pays
        // the creator from here (capped by duelPot) — never from the shared seed
        // vault — so duels can't drain each other or the owner's liquidity.
        duelPot[duelId] = pot;
        escrowedPot    += pot;

        // Seed virtual quote balance only on active pools for this tier.
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        for (uint256 i = 0; i < 3; i++) {
            if (mask & bits[i] == 0) continue;
            fighterBalances[mPools[i]][duelId][fighterA].quoteTokenAmount = initialUsdsoPerFighter;
            fighterBalances[mPools[i]][duelId][fighterB].quoteTokenAmount = initialUsdsoPerFighter;
        }

        emit ArenaTypes.DuelStarted(duelId, fighterA, fighterB, msg.sender, turns, mask, block.number);
    }

    /// @notice Finalize a completed duel. Anyone can call once all callbacks are in.
    ///         Uses live mark prices — safe because all turns are done and any further
    ///         book manipulation can't change which fighter holds which base tokens.
    function finalizeDuel(uint256 duelId) external {
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) revert ArenaTypes.DuelNotActive();
        if (duel.completedCallbacks < duel.turns * 2) revert ArenaTypes.DuelNotReadyToFinalize();
        _resolveDuel(duelId, duel, false);
    }

    /// @notice Safety valve: owner can force-resolve a duel stuck for EMERGENCY_FINALIZE_BLOCKS
    ///         without a turn advancing. Uses snapshot mark prices (recorded each turn) instead
    ///         of live prices, so the owner can't time the call to manipulate the outcome.
    function emergencyFinalize(uint256 duelId) external onlyOwner {
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) revert ArenaTypes.DuelNotActive();
        if (block.number < duel.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS)
            revert ArenaTypes.DuelNotReadyToFinalize();
        _resolveDuel(duelId, duel, true);
    }

    function _resolveDuel(uint256 duelId, ArenaTypes.Duel storage duel, bool useSnapshot) internal {
        duel.status = ArenaTypes.DuelStatus.Finalizing;

        address[3] memory pools = _duelPools(duelId);
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        uint256 valueA = 0;
        uint256 valueB = 0;

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            address pool = pools[i];
            uint256 snap = duelMarkSnapshots[duelId][pool];
            uint256 markPrice = useSnapshot ? snap : ArenaUtils.midMarkPrice(pool);

            // The live book decides the result, so a bad print at this one block
            // decides it too. Two ways that happens, both seen on testnet:
            //   - the book goes dark and midMarkPrice returns 0, which would value
            //     every base-token holding in this pool at nothing;
            //   - one side empties and a single stale order becomes the mark (the
            //     SOMI book carries an ask at 5.7x mid right now).
            // Either way the last turn's snapshot is the better estimate: it came
            // from the same midMarkPrice, and _snapshotMarkPrices only ever records
            // a non-zero price. Neither fighter chose the moment of finalize, so a
            // fighter must not lose their holding to it.
            // Deliberately not emitting a separate event for the fallback: Arena sits
            // 183 bytes under the 24576 limit with one, and MarkPriceSnapshot already
            // publishes every snapshot, so the substitution is reconstructable off-chain.
            if (snap > 0 && (markPrice == 0 || markPrice > snap * 2 || markPrice * 2 < snap)) {
                markPrice = snap;
            }

            // No snapshot either — the price is genuinely unknown. Proceed with 0 so
            // the duel still resolves and depositors can recoverFunds; locking it
            // forever would be worse.
            if (markPrice == 0) {
                emit ArenaTypes.DuelDegenerate(duelId, pool, "zero mark price at finalize");
            }

            uint256 baseUnit  = 10 ** uint256(poolMeta[pool].baseDecimals);
            ArenaTypes.PoolBalance memory balA = fighterBalances[pool][duelId][duel.fighterA];
            ArenaTypes.PoolBalance memory balB = fighterBalances[pool][duelId][duel.fighterB];
            valueA += balA.quoteTokenAmount + (balA.baseTokenAmount * markPrice / baseUnit);
            valueB += balB.quoteTokenAmount + (balB.baseTokenAmount * markPrice / baseUnit);
        }

        // Store the slot (0/1, or DRAW_SLOT) and emit the registry fighter id.
        //
        // This was `valueA >= valueB ? 0 : 1`, which handed every exact tie to
        // Player 1. Both fighters start with identical deposits, so any duel where
        // neither trades — all Holds, or every move coerced to Hold — ends exactly
        // level, and Player 2 lost their stake to a comparison operator.
        uint8 slot = valueA == valueB
            ? ArenaTypes.DRAW_SLOT
            : (valueA > valueB ? 0 : 1);
        uint8 winnerFighterId = slot == ArenaTypes.DRAW_SLOT
            ? type(uint8).max
            : (slot == 0 ? duel.fighterA : duel.fighterB);
        duel.winnerSlot = slot;
        duel.status = ArenaTypes.DuelStatus.Resolved;
        _dropActive(duelId);
        emit ArenaTypes.DuelResolved(duelId, winnerFighterId, valueA, valueB);
        if (slot == ArenaTypes.DRAW_SLOT) emit ArenaTypes.DuelDrawn(duelId, valueA, valueB);

        // Best-effort: record the outcome in the history sink. A revert here must
        // never block duel resolution, so it is wrapped in try/catch.
        address h = duelHistory;
        if (h != address(0)) {
            try IDuelHistory(h).onResolved(
                duelId,
                duel.fighterA,
                duel.fighterB,
                slot,
                valueA,
                valueB,
                duel.initialUsdsoPerFighter
            ) {} catch {}
        }
    }

    /// @notice Duel creator withdraws their USDso back after the duel resolves.
    ///         Pulls the per-duel entitled amount (sum of both fighters' tracked
    ///         quoteTokenAmount on each active pool) from the shared pool vault and
    ///         transfers it to the creator. Per-duel accounting prevents one duel's
    ///         creator from draining funds belonging to another duel.
    ///
    /// @dev    Sets fundsRecovered=true BEFORE any external call (Checks-Effects-Interactions)
    ///         to close the reentrancy window. Base-token balances are not recovered —
    ///         only USDso quote balances accumulated during trading.
    function recoverFunds(uint256 duelId) external {
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Resolved) revert ArenaTypes.DuelNotResolved();
        if (duel.creator != msg.sender) revert ArenaTypes.NotDuelCreator();
        if (duel.fundsRecovered) revert ArenaTypes.AlreadyRecovered();

        address[3] memory pools = _duelPools(duelId);
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];

        // Per-duel entitlement = sum of both fighters' tracked quote balances across
        // active pools at resolution time. The virtual model credits each fighter on
        // EVERY active pool, so this can exceed the real pot — it's capped below.
        uint256 entitled = 0;
        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            entitled += fighterBalances[pools[i]][duelId][duel.fighterA].quoteTokenAmount;
            entitled += fighterBalances[pools[i]][duelId][duel.fighterB].quoteTokenAmount;
        }

        // Pay from this contract's OWN escrowed balance, capped by the duel's pot.
        // Base-token holdings (quote traded away) are not refunded — that surplus
        // (pot − pay) is released from escrow and accrues to the platform.
        uint256 pot = duelPot[duelId];
        uint256 pay = entitled < pot ? entitled : pot;
        if (pay == 0) revert ArenaTypes.NothingToRecover();

        // Effects before interaction (CEI): mark recovered, release the full pot
        // from escrow, zero the per-duel pot.
        duel.fundsRecovered = true;
        escrowedPot   -= pot;
        duelPot[duelId] = 0;

        bool ok = IERC20Minimal(USDSO).transfer(msg.sender, pay);
        if (!ok) revert ArenaTypes.TransferFailed();

        emit ArenaTypes.DuelFundsRecovered(duelId, msg.sender, pay);
    }

    // ─── LLM request / response ───────────────────────────────────────────────

    /// @dev Never reverts: a failed request (low STT, or the platform reverting)
    ///      is counted as a completed callback and the turn proceeds, mirroring the
    ///      handleFighterResponse failure path. This stops one fighter's request
    ///      failure from atomically reverting the whole turn and stalling the duel.
    function _requestFighterMove(uint256 duelId, uint8 fighterId) internal {
        IFighterRegistry.Fighter memory f = registry.getFighter(fighterId);
        address[3] memory mPools = _duelPools(duelId);
        string memory marketSummary = ArenaUtils.buildMarketSummary(
            duelId, fighterId, duels[duelId],
            mPools[0], mPools[1], mPools[2],
            fighterBalances, poolMeta,
            duelMarkSnapshots, duelPrevMarkSnapshots
        );
        // Ask by NAME, constrained to the actions this fighter can execute.
        //
        // `inferNumber` extracts the first integer out of the model's free text and
        // clamps it into [min,max]. With actions numbered 0..6 that turned any large
        // number the model echoed from the prompt into 6 — SellSOMI, the highest
        // index — which is how a fighter came to sell a token it did not hold.
        // `inferString` with `allowedValues` constrains the answer set structurally
        // instead, so an inexecutable action is absent rather than merely discouraged.
        string[] memory allowed = ArenaUtils.actionNames(ArenaUtils.legalActions(
            duelId, fighterId, duels[duelId],
            mPools[0], mPools[1], mPools[2],
            fighterBalances, poolMeta
        ));
        bytes memory payload = abi.encodeWithSelector(
            ILLMInferenceAgent.inferString.selector,
            marketSummary,
            f.systemPrompt,
            false,
            allowed
        );

        IAgentRequester platform = IAgentRequester(PLATFORM_ADDR);
        uint256 deposit = platform.getRequestDeposit() + FIGHTER_DEPOSIT_TOPUP * 3;
        if (address(this).balance < deposit) {
            duels[duelId].completedCallbacks += 1;
            emit ArenaTypes.FighterMoveFailed(duelId, fighterId, "insufficient stt");
            return;
        }

        try platform.createRequest{value: deposit}(
            LLM_AGENT_ID,
            address(this),
            this.handleFighterResponse.selector,
            payload
        ) returns (uint256 requestId) {
            pendingTurns[requestId] = ArenaTypes.PendingTurn({
                duelId:   duelId,
                fighterId: fighterId,
                deadline: block.timestamp + FIGHTER_REQUEST_DEADLINE_SEC,
                exists:   true
            });
            emit ArenaTypes.FighterMoveRequested(duelId, fighterId, requestId);
        } catch {
            // Platform reverted (e.g. queue full / topup math) — count it as a
            // completed (failed) move so completedCallbacks still reaches turns×2
            // and the duel can finalize instead of hanging.
            duels[duelId].completedCallbacks += 1;
            emit ArenaTypes.FighterMoveFailed(duelId, fighterId, "request failed");
        }
    }

    function handleFighterResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory  /* details */
    ) external {
        if (msg.sender != PLATFORM_ADDR) revert ArenaTypes.OnlyPlatform();
        ArenaTypes.PendingTurn memory pt = pendingTurns[requestId];
        if (!pt.exists) {
            emit ArenaTypes.FighterMoveFailed(0, 0, "unknown request");
            return;
        }
        delete pendingTurns[requestId];

        if (status != ResponseStatus.Success || responses.length == 0) {
            duels[pt.duelId].completedCallbacks += 1;
            emit ArenaTypes.FighterMoveFailed(pt.duelId, pt.fighterId, "no consensus");
            return;
        }
        // Re-derive what this fighter can execute. Only its own trades move its own
        // balances, and those happen here, so the set is the same one the request was
        // built from — recomputing simply avoids trusting a stale copy.
        address[3] memory cPools = _duelPools(pt.duelId);
        uint8[] memory legal = ArenaUtils.legalActions(
            pt.duelId, pt.fighterId, duels[pt.duelId],
            cPools[0], cPools[1], cPools[2],
            fighterBalances, poolMeta
        );

        (bool decoded, string memory answer) = ArenaUtils.decodeStringResult(responses[0].result);
        (bool inSet, uint8 chosen) = decoded
            ? ArenaUtils.matchAction(legal, answer)
            : (false, uint8(ArenaTypes.FighterAction.Hold));

        // An answer outside the executable set must not burn the turn. The player
        // did not choose this fighter's words, and a platform-side miss should not
        // cost them the duel — take it as Hold and record what was actually asked for.
        if (!inSet) {
            emit ArenaTypes.FighterMoveCoerced(
                pt.duelId, pt.fighterId, decoded ? answer : "undecodable"
            );
        }

        ArenaTypes.FighterAction action = ArenaTypes.FighterAction(chosen);
        (bool ok, uint128 orderId) = _executeFighterAction(pt.duelId, pt.fighterId, action);
        duels[pt.duelId].completedCallbacks += 1;
        if (!ok) {
            emit ArenaTypes.FighterMoveFailed(pt.duelId, pt.fighterId, "exec failed");
            return;
        }
        // lastAction is uint8[2], indexed by SLOT (0=fighterA, 1=fighterB) — NOT
        // the registry fighterId (0..5), which would overflow the size-2 array.
        uint8 slot = pt.fighterId == duels[pt.duelId].fighterA ? 0 : 1;
        duels[pt.duelId].lastAction[slot] = uint8(action);
        emit ArenaTypes.FighterMove(pt.duelId, pt.fighterId, action, orderId);
    }

    /// @notice Owner can expire a timed-out pending turn to unblock finalization.
    function expireTurn(uint256 requestId) external onlyOwner {
        ArenaTypes.PendingTurn memory pt = pendingTurns[requestId];
        if (!pt.exists) revert ArenaTypes.UnknownRequest();
        if (block.timestamp <= pt.deadline) revert ArenaTypes.NotYetExpired();
        delete pendingTurns[requestId];
        duels[pt.duelId].completedCallbacks += 1;
        emit ArenaTypes.FighterMoveFailed(pt.duelId, pt.fighterId, "timed out");
    }

    // ─── Order execution ──────────────────────────────────────────────────────

    function _executeFighterAction(
        uint256 duelId,
        uint8   fighterId,
        ArenaTypes.FighterAction action
    ) internal returns (bool ok, uint128 orderId) {
        if (action == ArenaTypes.FighterAction.Hold) return (true, 0);

        address pool;
        bool isBid;

        // Resolve the action to a pool in this duel's own recorded set.
        // mp[0]=WETH, mp[1]=WBTC, mp[2]=SOMI.
        ArenaTypes.Duel storage duel = duels[duelId];
        address[3] memory mp = _duelPools(duelId);

        if      (action == ArenaTypes.FighterAction.BuyWBTC)  { pool = mp[1]; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellWBTC) { pool = mp[1]; isBid = false; }
        else if (action == ArenaTypes.FighterAction.BuyWETH)  { pool = mp[0]; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellWETH) { pool = mp[0]; isBid = false; }
        else if (action == ArenaTypes.FighterAction.BuySOMI)  { pool = mp[2]; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellSOMI) { pool = mp[2]; isBid = false; }
        else return (false, 0);

        // Reject trades on pools not active for this duel's tier.
        uint8 bit = _poolBit(pool);
        if (bit == 0 || duel.poolMask & bit == 0) {
            _reject(pool, fighterId, duelId, isBid, 0, 0, 1, "pool not in tier");
            return (false, 0);
        }

        OrderBookLevel[] memory levels;
        try ISpotPool(pool).getBookLevels(!isBid, 1) returns (OrderBookLevel[] memory l) {
            levels = l;
        } catch {
            _reject(pool, fighterId, duelId, isBid, 0, 0, 1, "book read failed");
            return (false, 0);
        }
        if (levels.length == 0 || levels[0].quantity == 0) {
            _reject(pool, fighterId, duelId, isBid, 0, 0, 1, "empty book");
            return (false, 0);
        }

        uint256 price     = levels[0].price;
        uint256 available = levels[0].quantity;

        ArenaTypes.PoolMeta    memory meta    = poolMeta[pool];
        ArenaTypes.PoolBalance storage bal    = fighterBalances[pool][duelId][fighterId];
        uint256 baseUnit = 10 ** uint256(meta.baseDecimals);
        uint256 desired;

        if (isBid) {
            if (bal.quoteTokenAmount == 0) {
                _reject(pool, fighterId, duelId, isBid, price, 0, 1, "no quote balance");
                return (false, 0);
            }
            uint256 minCost = (meta.minQuantity * price) / baseUnit;
            uint256 vaultQuote = ISpotPool(pool).getWithdrawableBalance(address(this), USDSO);
            if (vaultQuote < minCost) {
                _reject(pool, fighterId, duelId, isBid, price, 0, 1, "vault below min cost");
                return (false, 0);
            }
            desired = meta.minQuantity;
        } else {
            if (bal.baseTokenAmount == 0) {
                _reject(pool, fighterId, duelId, isBid, price, 0, 1, "no base balance");
                return (false, 0);
            }
            desired = bal.baseTokenAmount;
        }

        uint256 quantity = desired < available ? desired : available;
        if (meta.lotSize > 0)    quantity = (quantity / meta.lotSize) * meta.lotSize;
        if (quantity == 0) {
            _reject(pool, fighterId, duelId, isBid, price, 0, 1, "zero quantity");
            return (false, 0);
        }
        if (quantity < meta.minQuantity) {
            _reject(pool, fighterId, duelId, isBid, price, quantity, 1, "below minQuantity");
            return (false, 0);
        }
        if (meta.tickSize > 0) {
            price = isBid
                ? ((price + meta.tickSize - 1) / meta.tickSize) * meta.tickSize
                : (price / meta.tickSize) * meta.tickSize;
        }

        (ok, orderId) = _placeOrderForFighter(duelId, fighterId, pool, isBid, price, quantity, 1, 3600);
        if (ok) {
            uint256 quoteCost = (price * quantity) / baseUnit;
            if (isBid) {
                if (quoteCost > bal.quoteTokenAmount) quoteCost = bal.quoteTokenAmount;
                bal.quoteTokenAmount -= quoteCost;
                bal.baseTokenAmount  += quantity;
            } else {
                bal.baseTokenAmount   = bal.baseTokenAmount > quantity ? bal.baseTokenAmount - quantity : 0;
                bal.quoteTokenAmount += quoteCost;
            }
        }
    }

    function _placeOrderForFighter(
        uint256 duelId,
        uint8   fighterId,
        address pool,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint8   orderType,
        uint64  expireOffsetSec
    ) internal returns (bool ok, uint128 orderId) {
        _requireValidPool(pool);
        if (expireOffsetSec == 0 || expireOffsetSec > MAX_EXPIRE_OFFSET_SEC) revert ArenaTypes.InvalidExpiry();
        if (orderType > 3) revert ArenaTypes.BadOrderType();

        uint64 expireTimestampNs = (uint64(block.timestamp) + expireOffsetSec) * 1_000_000_000;

        try ISpotPool(pool).placeOrder(isBid, 0, price, quantity, expireTimestampNs, orderType, 0, address(0), 0)
            returns (bool success, uint128 returnedId)
        {
            if (!success) {
                _reject(pool, fighterId, duelId, isBid, price, quantity, orderType, "silent reject");
                return (false, 0);
            }
            ok = true;
            orderId = returnedId;
        } catch {
            _reject(pool, fighterId, duelId, isBid, price, quantity, orderType, "pool reverted");
            return (false, 0);
        }

        emit ArenaTypes.OrderPlaced(pool, fighterId, duelId, orderId, isBid, price, quantity, orderType);
        // FOK orders (orderType=1) from _executeFighterAction update fighter balances
        // at the call site — this function only places the order and emits.
    }

    // ─── Active-duel set ──────────────────────────────────────────────────────

    /// @dev Swap-and-pop the resolved duel out of activeDuelIds. Order is not
    ///      meaningful, so moving the tail into the hole keeps removal O(1).
    function _dropActive(uint256 duelId) internal {
        uint256 idxPlusOne = _activeIndex[duelId];
        if (idxPlusOne == 0) return;
        uint256 idx  = idxPlusOne - 1;
        uint256 last = activeDuelIds.length - 1;
        if (idx != last) {
            uint256 moved = activeDuelIds[last];
            activeDuelIds[idx] = moved;
            _activeIndex[moved] = idx + 1;
        }
        activeDuelIds.pop();
        _activeIndex[duelId] = 0;
    }

    /// @notice Every running duel id.
    function getActiveDuelIds() external view returns (uint256[] memory) {
        return activeDuelIds;
    }

    /// @notice True when another duel can be started. Matchmaker gates on this.
    function hasCapacity() external view returns (bool) {
        return activeDuelIds.length < maxActiveDuels;
    }

    /// @notice Deprecated single-duel view, kept so older consumers still read
    ///         something sane. Returns the first running duel, or 0 if none.
    ///         Use getActiveDuelIds() — this cannot see the others.
    function activeDuelId() external view returns (uint256) {
        return activeDuelIds.length > 0 ? activeDuelIds[0] : 0;
    }

    /// @notice Running duels whose turn interval has elapsed and which still have
    ///         moves outstanding. The keeper calls this once per tick and then
    ///         turn(id) on each, instead of polling every duel separately.
    function duelsReadyForTurn() external view returns (uint256[] memory ready) {
        uint256[] memory ids = activeDuelIds;
        uint256 n = 0;
        uint256[] memory buf = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            ArenaTypes.Duel storage d = duels[ids[i]];
            if (d.status != ArenaTypes.DuelStatus.Active) continue;
            if (block.number < d.lastTurnBlock + TURN_INTERVAL_BLOCKS) continue;
            if (d.completedCallbacks >= d.turns * 2) continue;
            buf[n++] = ids[i];
        }
        ready = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ready[i] = buf[i];
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _poolBit(address pool) internal view returns (uint8) {
        if (pool == POOL_WETH || pool == SIM_POOL_WETH) return ArenaTypes.POOL_BIT_WETH;
        if (pool == POOL_WBTC || pool == SIM_POOL_WBTC) return ArenaTypes.POOL_BIT_WBTC;
        if (pool == POOL_SOMI || pool == SIM_POOL_SOMI) return ArenaTypes.POOL_BIT_SOMI;
        return 0;
    }

    /// @notice Resolve the active pool set for a duel: the real pools, or the
    ///         simulated mock set when the duel was created with simulated == true.
    ///         Returned order is [WETH, WBTC, SOMI] to match the bit ordering.
    /// @notice The pool set a duel is bound to. Kept as a function rather than a
    ///         bare mapping read so the three-slot load is emitted once instead of
    ///         at all seven call sites — Arena has no room for the inlined copies.
    function _duelPools(uint256 duelId) internal view returns (address[3] memory) {
        return duelPools[duelId];
    }

    function _pools(bool simulated) internal view returns (address[3] memory) {
        if (simulated) return [SIM_POOL_WETH, SIM_POOL_WBTC, SIM_POOL_SOMI];
        return [POOL_WETH, POOL_WBTC, POOL_SOMI];
    }

    /// @dev Single OrderRejected emit site. Folding the ~10 rejection paths through
    ///      one helper keeps the event ABI encoded once in bytecode instead of at
    ///      every call site (meaningful contract-size saving).
    function _reject(
        address pool, uint8 fighterId, uint256 duelId, bool isBid,
        uint256 price, uint256 quantity, uint8 orderType, string memory reason
    ) internal {
        emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, quantity, orderType, reason);
    }

    /// @notice Returns the minimum USDso deposit (excluding platform fee) for a turn
    ///         tier on the REAL pool set. Kept for backward compatibility.
    function minDepositFor(uint16 turns) external view returns (uint256) {
        return ArenaUtils.minDepositFor(turns, POOL_WETH, POOL_WBTC, POOL_SOMI, poolMeta);
    }

    /// @notice Minimum USDso deposit for a turn tier on the chosen market (real or
    ///         simulated). Matchmaker uses this so simulated queues price correctly.
    function minDepositForMarket(uint16 turns, bool simulated) external view returns (uint256) {
        address[3] memory mp = _pools(simulated);
        return ArenaUtils.minDepositFor(turns, mp[0], mp[1], mp[2], poolMeta);
    }

    /// @notice The exact prompt and allowed action list a fighter would be asked
    ///         with right now, without spending an inference.
    ///
    ///         Exposed because the central guarantee of the prompt layer — that no
    ///         digit reaches the model, so nothing can be extracted and clamped into
    ///         a trade the fighter cannot make — is otherwise unobservable until a
    ///         duel is already running and the STT is already spent.
    function previewTurnPrompt(uint256 duelId, uint8 fighterId)
        external view returns (string memory prompt, string[] memory allowed)
    {
        address[3] memory mp = _duelPools(duelId);
        prompt = ArenaUtils.buildMarketSummary(
            duelId, fighterId, duels[duelId],
            mp[0], mp[1], mp[2],
            fighterBalances, poolMeta, duelMarkSnapshots, duelPrevMarkSnapshots
        );
        allowed = ArenaUtils.actionNames(ArenaUtils.legalActions(
            duelId, fighterId, duels[duelId], mp[0], mp[1], mp[2], fighterBalances, poolMeta
        ));
    }

    // ─── Debug / test helpers (testnet only) ─────────────────────────────────

    function testRequestFighterMove(uint256 duelId, uint8 fighterId) external onlyOwner {
        _requestFighterMove(duelId, fighterId);
    }
}
