// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../lib/ArenaUtils.sol";
import "../interfaces/IFighterRegistry.sol";
import "../interfaces/IERC20Minimal.sol";
import "../interfaces/IDuelHistory.sol";
import "../interfaces/IPerps.sol";
import "../interfaces/ISpotPool.sol";

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
        if (marketKind > uint8(ArenaTypes.MarketKind.Perps)) revert ArenaTypes.InvalidMarketKind();
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
        //
        // Perps is the one market with no fixed pool set to look up. Which three of
        // the six markets a fight gets is decided HERE, from what its budget can
        // actually afford at this moment — because the margin a market costs scales
        // with open interest and moves on its own. `nextDuelId` is the rotation salt,
        // so two consecutive fights at the same tier are not the same fight.
        if (kind == ArenaTypes.MarketKind.Perps) {
            return _start(
                fighterA, fighterB, turns, kind,
                _selectPerpPools(ArenaUtils.perpBudget(turns), nextDuelId)
            );
        }
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

        // The fee is operating cost, not revenue, and it leaves NOW.
        //
        // It pays for the fighters' thinking, which is billed in the chain's own
        // coin — a currency this fee is not denominated in. A separate pot converts
        // it. Sending the fee there at creation rather than letting it sit here is
        // what keeps this contract's balance to exactly two claims: players'
        // escrowed stakes and the owner's seed. A third claim living here would mean
        // the buy gate had to subtract it too, or a fighter's purchase could quietly
        // spend the thinking budget.
        //
        // Best-effort, and it falls back to the old behaviour: a pot that is unset,
        // or a transfer that fails, must never stop a fight being created.
        address feeSink = fuelPot;
        bool routed = false;
        if (feeSink != address(0)) {
            try IERC20Minimal(USDSO).transfer(feeSink, fee) returns (bool sent) {
                routed = sent;
            } catch { routed = false; }
        }
        if (routed) {
            emit ArenaTypes.FeeRouted(feeSink, fee);
        } else {
            accruedFees += fee;
        }
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

        // On perps each fighter also needs an ADDRESS of its own, because margin is
        // cross and keyed on the trader's address: two fighters trading from Arena's
        // address would share one margin pool, and a liquidation caused by one could
        // seize collateral backing the other. One account per fighter for the whole
        // fight — not one per market — so a fighter's three slots pool their margin
        // the way a real trader's would.
        //
        // Deliberately NOT wrapped in try/catch. A fight whose fighters have no
        // funded accounts is a fight where every move fails, and taking a player's
        // deposit for that is worse than refusing to start.
        if (kind == ArenaTypes.MarketKind.Perps) {
            emit ArenaTypes.PerpMarketsSelected(duelId, mPools, initialUsdsoPerFighter);
            _leasePerpAccount(duelId, fighterA, initialUsdsoPerFighter);
            _leasePerpAccount(duelId, fighterB, initialUsdsoPerFighter);
        }

        emit ArenaTypes.DuelStarted(duelId, fighterA, fighterB, msg.sender, turns, mask, block.number);

        // Arm the first tick. Nothing is armed while the arena is empty, so this is
        // what starts the chain — and if a duel already running is due sooner, this
        // leaves that earlier subscription alone.
        _scheduleNextTick();
    }


    function _leasePerpAccount(uint256 duelId, uint8 fighterId, uint256 budget) internal {
        address account = IPerpRegistry(perpRegistry).lease(duelId, fighterId, budget);
        // Seed the first score reading now, so a fight whose oracle goes stale before
        // its first turn still has something truthful to fall back on rather than a
        // zero that would read as a wiped-out fighter.
        perpEquitySnapshots[duelId][fighterId] = budget;
        emit ArenaTypes.PerpAccountLeased(duelId, fighterId, account, budget);
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

        // A perps fighter is not scored slot by slot. Its three slots share one
        // margin pot, and the protocol already keeps the only correct total for that
        // pot: account equity — collateral plus unrealised profit plus realised plus
        // funding, in one signed number, measured exact to zero wei against
        // `deposit + size x (mark - entry)`. Adding the slots up separately would
        // count the same money three times.
        //
        // This is also the whole reason shorting was nearly free to add. Once the
        // score is equity rather than cash-plus-holdings, a negative position is
        // handled by the protocol's own arithmetic instead of by an accounting rewrite.
        bool perps = poolIsPerp[pools[0]];
        if (perps) {
            valueA = _perpScore(duelId, duel.fighterA, useSnapshot);
            valueB = _perpScore(duelId, duel.fighterB, useSnapshot);
        }

        for (uint256 i = 0; !perps && i < 3; i++) {
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

        // Close both fighters' positions and take the collateral back into the float.
        //
        // AFTER the result is stored and emitted, and best-effort. The flatten can
        // genuinely fail — a book can go dark, a market can flip to close-only — and a
        // revert on this path would freeze the fight. A frozen fight is one where the
        // players cannot recover their stake, which is far worse than seed collateral
        // sitting in a quarantined account until someone retries it. Same rule, and
        // the same shape, as the history-sink write above.
        if (perps) {
            _releasePerpAccount(duelId, duel.fighterA);
            _releasePerpAccount(duelId, duel.fighterB);
        }

        // Turn whatever the house is holding back into cash.
        //
        // Every buy a fighter makes converts house cash into an asset delivered to
        // this contract, and nothing converted it back — so cash fell while holdings
        // rose, and the money was still there but in a form the buy gate could not
        // spend. Measured across one fifteen-round fight: 27.57 cash out, 0.013 of an
        // asset in, the same money in a different shape. Recovering it used to be an
        // operator remembering to run a script.
        //
        // AFTER the result is stored and emitted, exactly like the two blocks above,
        // and for a stronger reason than either: a fighter is scored on its cash PLUS
        // its holdings valued at the mark, so selling before the score is computed
        // would change who won.
        if (!perps) _settleHeldAssets(duelId, pools, duel.poolMask);

        // Re-aim at whichever fight is now due soonest — or cancel outright, which
        // is what happens on the last one out. An idle arena pays nothing.
        _scheduleNextTick();
    }

    /// @dev Sell this contract's holding of each of a fight's assets back to cash.
    ///
    ///      Best-effort throughout, and that is the whole design. If finalising can
    ///      fail, a payout gets stuck; a stuck payout blocks the next rewire, which
    ///      has already blocked one release. So every sale is wrapped, every refusal
    ///      is an event, and nothing here can revert the resolution that called it.
    ///
    ///      Three rules learned the expensive way:
    ///
    ///      SIZE TO THE RESTING DEPTH, not to the holding. These orders are
    ///      all-or-nothing, so offering more than the book is holding cancels the
    ///      whole sale rather than filling part of it — 0.067 offered against a book
    ///      holding 0.046 was refused outright. A large holding therefore settles
    ///      across several fights, which is fine.
    ///
    ///      ROUND DOWN TO THE VENUE'S STEP. A raw balance almost never is a whole
    ///      multiple of it, and an unaligned quantity is simply declined.
    ///
    ///      NEVER TOUCH THE NATIVE ASSET. One market's asset is the chain's own coin,
    ///      and this contract's coin balance is what pays for the fighters' thinking.
    ///      Selling it would convert fuel into cash, which is backwards — the fuel pot
    ///      converts in the other direction on purpose.
    function _settleHeldAssets(uint256 duelId, address[3] memory pools, uint8 mask) internal {
        uint8[3] memory bits = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        for (uint256 i = 0; i < 3; i++) {
            if (mask & bits[i] == 0) continue;
            // Leave room for the rest of finalisation. Selling three assets is three
            // orders, and a fight that cannot finish is far worse than an asset that
            // waits for the next one.
            if (gasleft() < 1_500_000) {
                emit ArenaTypes.AssetSettleSkipped(duelId, pools[i], "not enough gas left this block");
                return;
            }
            _settleOne(duelId, pools[i]);
        }
    }

    /// @dev One market. Split out so the loop above stays shallow — the resolution
    ///      path already carries a lot of locals and this adds none to it.
    function _settleOne(uint256 duelId, address pool) internal {
        address base;
        uint256 step;
        try ISpotPool(pool).getPoolParams() returns (
            address b, address, uint256, uint256, uint256 tickSize, uint256, uint256 lotSize
        ) {
            base = b;
            step = lotSize == 0 ? 1 : lotSize;
            if (tickSize == 0) { emit ArenaTypes.AssetSettleSkipped(duelId, pool, "venue has no tick"); return; }
        } catch { emit ArenaTypes.AssetSettleSkipped(duelId, pool, "venue would not answer"); return; }

        if (base == address(0) || base.code.length == 0) {
            emit ArenaTypes.AssetSettleSkipped(duelId, pool, "the chain's own coin is fuel, not inventory");
            return;
        }

        uint256 held;
        try IERC20Minimal(base).balanceOf(address(this)) returns (uint256 b2) { held = b2; }
        catch {
            // A prediction position, which is DELIBERATELY not sold here. Its
            // collateral is a different token from this contract's cash with no
            // swap route between them, and the desk sends what it sells to its own
            // owner — so selling at the bell would move money away from here, not
            // back into it. The desk claims the payout itself once the question
            // resolves, and scoring already values the position at the mark.
            //
            // The message says so, because the old one read like a broken token and
            // sent the next reader hunting a fault that was not there.
            emit ArenaTypes.AssetSettleSkipped(duelId, pool, "a prediction is claimed at its desk, not sold here");
            return;
        }
        if (held == 0) return;

        uint256 price;
        uint256 qty;
        try ISpotPool(pool).getBookLevels(true, 1) returns (OrderBookLevel[] memory lv) {
            if (lv.length == 0 || lv[0].quantity == 0) {
                emit ArenaTypes.AssetSettleSkipped(duelId, pool, "nobody bidding");
                return;
            }
            qty = held < lv[0].quantity ? held : lv[0].quantity;
            qty = (qty / step) * step;
            // Twenty steps through the bid. A settlement is allowed to pay for
            // certainty; the point is that the asset leaves, not that it leaves well.
            price = lv[0].price;
        } catch { emit ArenaTypes.AssetSettleSkipped(duelId, pool, "book unreadable"); return; }
        if (qty == 0) { emit ArenaTypes.AssetSettleSkipped(duelId, pool, "holding below one step"); return; }

        uint256 before = IERC20Minimal(USDSO).balanceOf(address(this));
        try IERC20Minimal(base).approve(pool, qty) returns (bool) {} catch {
            emit ArenaTypes.AssetSettleSkipped(duelId, pool, "asset refused the approval");
            return;
        }
        bool filled;
        try ISpotPool(pool).placeOrder(
            false, 0, price, qty, uint64(block.timestamp + 3600) * 1_000_000_000, 1, 0, address(0), 0
        ) returns (bool ok, uint128) { filled = ok; } catch { filled = false; }
        // No standing approval survives, whatever happened.
        try IERC20Minimal(base).approve(pool, 0) returns (bool) {} catch {}

        if (!filled) { emit ArenaTypes.AssetSettleSkipped(duelId, pool, "the venue declined"); return; }
        uint256 proceeds = IERC20Minimal(USDSO).balanceOf(address(this)) - before;
        emit ArenaTypes.AssetSettled(duelId, pool, qty, proceeds);
    }


    /// @dev A fighter's score: live equity, clamped at zero, with the last healthy
    ///      reading as the fallback.
    ///
    ///      Clamped because a liquidated fighter's equity can go NEGATIVE, and a
    ///      negative score would make the comparison below meaningless while telling
    ///      the winner nothing they do not already know. Zero says the same thing:
    ///      wiped out, lost.
    ///
    ///      The fallback matters more here than on a spot book. Equity is a live
    ///      oracle read, and nobody chose the moment of finalize — so an oracle that
    ///      happens to be stale at this block must not decide the fight. The snapshot
    ///      is written at the start of every turn from the same source.
    /// @param useSnapshot forces the last recorded score instead of the live one.
    ///        This is what makes `emergencyFinalize` safe on a perps fight, and it is
    ///        not optional. That function exists so the OWNER cannot pick the moment a
    ///        stuck duel is scored — and a perps score is a live oracle read, so
    ///        without this the owner could simply wait for a mark that favours the
    ///        fighter they want to win. The spot path has always honoured this flag;
    ///        the perps path read live equity regardless, which quietly re-opened
    ///        exactly the hole the flag was added to close.
    function _perpScore(uint256 duelId, uint8 fighterId, bool useSnapshot)
        internal returns (uint256 score)
    {
        bool live;
        int256 equity;
        address reg = perpRegistry;
        if (!useSnapshot && reg != address(0)) {
            try IPerpRegistry(reg).equityOf(duelId, fighterId) returns (bool ok, int256 e) {
                live = ok;
                equity = e;
            } catch {}
        }
        score = live
            ? (equity > 0 ? uint256(equity) : 0)
            : perpEquitySnapshots[duelId][fighterId];
        emit ArenaTypes.PerpFighterScored(duelId, fighterId, equity, live);
    }


    function _releasePerpAccount(uint256 duelId, uint8 fighterId) internal {
        address reg = perpRegistry;
        if (reg == address(0)) return;
        try IPerpRegistry(reg).release(duelId, fighterId) returns (uint256 reclaimed, bool clean) {
            emit ArenaTypes.PerpAccountReleased(duelId, fighterId, reclaimed, clean);
        } catch {
            // The account keeps whatever it holds and stays leased, so
            // `retryRelease` on the registry can pick it up later. Nothing about the
            // fight's outcome or the players' money depends on this succeeding.
            emit ArenaTypes.PerpAccountReleased(duelId, fighterId, 0, false);
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
