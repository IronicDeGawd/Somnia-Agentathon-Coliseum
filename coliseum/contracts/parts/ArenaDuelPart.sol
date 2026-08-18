// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../lib/ArenaUtils.sol";
import "../interfaces/IFighterRegistry.sol";
import "../interfaces/IERC20Minimal.sol";
import "../interfaces/IDuelHistory.sol";

/// @title ArenaDuelPart
/// @notice A duel's beginning and end: taking the deposit, escrowing the pot,
///         valuing both fighters at the finish, and paying the creator back.
///         Everything in between — turns, prompts, orders — lives in the turn
///         part.
///
///         Deployed on its own and reached through the router by delegatecall, so
///         the deposit it pulls in and the payout it sends both move against the
///         ROUTER's balance. This contract never holds anything.
///
///         Declares no storage. See ArenaStorage.sol for why that rule is absolute.
contract ArenaDuelPart is ArenaStorage {

    using ArenaUtils for *;


    /// @notice Raise or lower how many duels may run at once. Lowering below the
    ///         current count does not cancel anything — it only stops new starts
    ///         until enough resolve.
    function setMaxActiveDuels(uint16 n) external onlyOwner {
        if (n == 0 || n > MAX_ACTIVE_CEILING) revert ArenaTypes.BadMaxActiveDuels();
        maxActiveDuels = n;
        emit ArenaTypes.MaxActiveDuelsSet(n);
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
        return _startOn(
            fighterA, fighterB, turns,
            simulated ? ArenaTypes.MarketKind.Practice : ArenaTypes.MarketKind.Spot
        );
    }

    /// @notice Start a duel on a chosen market: the real coin books, the mock
    ///         books, or the events set, whose three slots all hold live
    ///         prediction questions.
    ///
    ///         Spot and events fights coexist. Each fight records its own three
    ///         markets when it starts, so an expensive real-asset fight and a
    ///         cheap events one run side by side and neither can disturb the
    ///         other's prices, balances or payout.
    ///
    ///         Every turn count is accepted on every market. Which combinations
    ///         are actually offered is a lobby decision, not a contract one, so
    ///         the menu can change without redeploying anything. On spot the
    ///         tier ladder still narrows the slots for short fights; on events
    ///         every tier trades all three.
    function startDuelOn(
        uint8  fighterA,
        uint8  fighterB,
        uint16 turns,
        uint8  marketKind
    ) external returns (uint256 duelId) {
        if (marketKind > uint8(ArenaTypes.MarketKind.Events)) revert ArenaTypes.InvalidMarketKind();
        return _startOn(fighterA, fighterB, turns, ArenaTypes.MarketKind(marketKind));
    }

    function _startOn(
        uint8  fighterA,
        uint8  fighterB,
        uint16 turns,
        ArenaTypes.MarketKind kind
    ) internal returns (uint256 duelId) {
        // `simulated` on the duel record still means only "the mock books", which
        // is what every consumer reading that flag has always assumed.
        return _start(fighterA, fighterB, turns, kind, _poolsFor(kind));
    }

    /// @notice Start a duel on the registered event-contract desks.
    ///
    ///         Owner-only, because the desks have to be pointed at a live
    ///         prediction window immediately beforehand and only the operator's
    ///         bot knows which window is open. Players reach ordinary duels
    ///         through the queue; that path is deliberately unchanged.
    ///
    ///         The duel is recorded as a real (not simulated) one. An event duel
    ///         is not a third kind of fight — it is an ordinary fight whose three
    ///         markets happen to be prediction desks, which is why nothing about
    ///         escrow, scoring or payout differs here.
    function startEventDuel(
        uint8  fighterA,
        uint8  fighterB,
        uint16 turns
    ) external onlyOwner returns (uint256 duelId) {
        return _startOn(fighterA, fighterB, turns, ArenaTypes.MarketKind.Events);
    }

    /// @dev The one place a duel is created. Both entry points come through here
    ///      so there is a single deposit-and-escrow path, not two that could
    ///      drift apart.
    /// @param mPools the three markets this duel is bound to, [WETH, WBTC, SOMI].
    function _start(
        uint8  fighterA,
        uint8  fighterB,
        uint16 turns,
        ArenaTypes.MarketKind kind,
        address[3] memory mPools
    ) internal returns (uint256 duelId) {
        // Duels run concurrently up to maxActiveDuels. Everything that could
        // collide between them — escrow, per-fighter balances, mark snapshots,
        // odds and bets — is already keyed by duelId, so the only shared resource
        // is this contract's STT balance for inference (see the watcher fuel guard).
        if (activeDuelIds.length >= maxActiveDuels)
            revert ArenaTypes.ArenaFull(activeDuelIds.length, maxActiveDuels);

        if (!ArenaUtils.isValidTurnCount(turns)) revert ArenaTypes.InvalidTurnCount();

        uint8 count = registry.FIGHTER_COUNT();
        if (fighterA == fighterB || fighterA >= count || fighterB >= count)
            revert ArenaTypes.InvalidFighterPair();

        // Compute minimum deposit for this tier and pull from caller.
        uint256 minDeposit = ArenaUtils.minDepositFor(
            turns, kind, mPools[0], mPools[1], mPools[2], poolMeta
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

        uint8 mask = ArenaUtils.poolMaskFor(turns, kind);

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
            simulated:               kind == ArenaTypes.MarketKind.Practice
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
}
