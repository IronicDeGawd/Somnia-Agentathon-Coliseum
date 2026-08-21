// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../lib/ArenaUtils.sol";
import "../interfaces/IFighterRegistry.sol";
import "../interfaces/ISpotPool.sol";
import "../interfaces/ISomniaAgents.sol";
import "../interfaces/IPerps.sol";

/// @title ArenaTurnPart
/// @notice A duel's middle: advancing turns, snapshotting prices, asking each
///         fighter for a move, and executing the move it chose as an order on
///         the market.
///
///         Deployed on its own and reached through the router by delegatecall, so
///         orders are placed as the ROUTER and fill against the router's vault
///         position. This contract never trades or holds anything itself.
///
///         Declares no storage. See ArenaStorage.sol for why that rule is absolute.
contract ArenaTurnPart is ArenaStorage {

    using ArenaUtils for *;


    // ─── Reactivity callback ─────────────────────────────────────────────────

    /// @dev There is deliberately no check that the firing's block is a multiple of
    ///      the turn interval. That check made sense only while the subscription
    ///      fired on every block and most firings had to be thrown away; against a
    ///      subscription aimed at one named block it would discard nearly every
    ///      firing we paid for. _runTurn's own interval check is the real guard.
    function onEvent(address /*emitter*/, bytes32[] calldata eventTopics, bytes calldata /*data*/) external {
        if (msg.sender != SOMNIA_REACTIVITY_PRECOMPILE) return;
        if (eventTopics.length < 2) return;
        // ONE DUEL PER FIRING. A turn is two inference requests, and their cost is
        // the platform's rather than ours: measured 7,477,821 gas one hour and
        // 29,382,823 the next, on the same contract and the same fight length. So the
        // budget for a firing cannot be divided by however many duels happen to be
        // due — advancing all of them exceeded the cap and the firing reverted, which
        // books no successor and ends the chain silently. Five concurrent fights
        // stalled for fifteen thousand blocks that way, with nothing reporting it.
        //
        // Advancing one and re-arming is not slower in practice: any duel still
        // overdue makes `_nextTurnBlock` return the very next block, so the remaining
        // ones are picked up in consecutive blocks rather than all in one transaction.
        // A duel whose interval has not elapsed costs about 49,000 gas to skip.
        uint256[] memory ids = activeDuelIds;
        for (uint256 i = 0; i < ids.length; i++) {
            if (_runTurn(ids[i])) break;
        }
        // This firing is spent. Book the next one, or the chain ends here.
        _scheduleNextTick();
    }


    /// @notice Manual turn advance, owner-only. Reactivity `onEvent` drives turns automatically;
    ///         this is a fallback for when a firing never lands. Public access would let an
    ///         attacker time turns to sandwich pool manipulation around LLM context reads.
    function turn(uint256 duelId) external onlyOwner {
        _runTurn(duelId);
        // Re-arm even though the keeper drove this turn. Without it, a single
        // watchdog-driven turn would leave the subscription pointed at a block that
        // has already passed — the chain would die at exactly the moment the safety
        // net was supposed to catch it.
        _scheduleNextTick();
    }


    /// @return advanced true when this call actually took a turn, so a caller can
    ///         stop after one rather than paying for every duel in one transaction.
    function _runTurn(uint256 duelId) internal returns (bool advanced) {
        if (duelId == 0) return false;
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) return false;
        if (block.number < duel.lastTurnBlock + TURN_INTERVAL_BLOCKS) return false;
        if (duel.completedCallbacks >= duel.turns * 2) return false;
        duel.lastTurnBlock = block.number;
        advanced = true;

        // Snapshot mark prices on every active pool BEFORE any LLM requests.
        // emergencyFinalize will use these snapshots instead of live prices.
        _snapshotMarkPrices(duelId, duel);

        _requestFighterMove(duelId, duel.fighterA);
        _requestFighterMove(duelId, duel.fighterB);
        emit ArenaTypes.TurnAdvanced(duelId, duel.completedCallbacks, block.number);
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
                uint256 was = duelMarkSnapshots[duelId][pools[i]];
                duelPrevMarkSnapshots[duelId][pools[i]] = was;
                duelMarkSnapshots[duelId][pools[i]] = mp;

                // Remember the biggest single-turn move this market has made, so the
                // prompt can say whether THIS turn is the biggest thing that has
                // happened rather than quoting a basis-point figure nobody can
                // calibrate. Written here because this is the only place that sees
                // both prices; the first turn has no prior mark and so no step.
                if (was > 0) {
                    uint256 step = mp > was ? mp - was : was - mp;
                    uint256 stepBps = (step * 10000) / was;
                    if (stepBps > duelMaxStepBps[duelId][pools[i]]) {
                        duelMaxStepBps[duelId][pools[i]] = stepBps;
                    }
                }
                // The opening price is written once and then left alone. A perp mark
                // barely moves across one turn, so it is the distance from HERE that
                // tells a fighter whether a market is trending or just wobbling.
                if (duelOpenMarkSnapshots[duelId][pools[i]] == 0) {
                    duelOpenMarkSnapshots[duelId][pools[i]] = mp;
                }
                emit ArenaTypes.MarkPriceSnapshot(duelId, pools[i], mp, turnNum);
            }
        }

        // On a perps fight the score is not cash plus holdings, it is account equity —
        // a live oracle read. So the score itself needs the same protection the mark
        // prices above get: one reading per turn, taken while the market is known
        // healthy, for finalize to fall back on if the oracle is stale at the moment
        // the fight ends. Without it a stale feed at exactly the wrong block would
        // score both fighters zero and turn a decided fight into a draw.
        if (poolIsPerp[pools[0]]) {
            _snapshotPerpEquity(duelId, duel.fighterA);
            _snapshotPerpEquity(duelId, duel.fighterB);
        }
    }

    /// @dev A failed read leaves the previous snapshot in place rather than
    ///      overwriting it with a zero, because "we could not see it" and "it is
    ///      gone" are very different claims about a fighter's money.
    function _snapshotPerpEquity(uint256 duelId, uint8 fighterId) internal {
        address reg = perpRegistry;
        if (reg == address(0)) return;
        try IPerpRegistry(reg).equityOf(duelId, fighterId) returns (bool ok, int256 equity) {
            if (ok) perpEquitySnapshots[duelId][fighterId] = equity > 0 ? uint256(equity) : 0;
        } catch {}
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
            mPools[0], mPools[1], mPools[2], USDSO,
            fighterBalances, poolMeta,
            duelMarkSnapshots, duelPrevMarkSnapshots, duelOpenMarkSnapshots,
            duelMaxStepBps, poolLabel, poolIsPerp
        );
        // Ask by NAME, constrained to the actions this fighter can execute.
        //
        // `inferNumber` extracts the first integer out of the model's free text and
        // clamps it into [min,max]. With actions numbered 0..6 that turned any large
        // number the model echoed from the prompt into 6 — SellSOMI, the highest
        // index — which is how a fighter came to sell a token it did not hold.
        // `inferString` with `allowedValues` constrains the answer set structurally
        // instead, so an inexecutable action is absent rather than merely discouraged.
        // The vocabulary comes from the duel's own recorded pools, and the reply
        // path below rebuilds it the same way. They must agree, or a named answer
        // lands outside the set and every event trade becomes a silent Hold.
        string[] memory allowed = ArenaUtils.actionNames(ArenaUtils.legalActions(
            duelId, fighterId, duels[duelId],
            mPools[0], mPools[1], mPools[2], USDSO,
            fighterBalances, poolMeta, poolIsPerp
        ), ArenaUtils.vocabFor(mPools, poolLabel, poolIsPerp));
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
            cPools[0], cPools[1], cPools[2], USDSO,
            fighterBalances, poolMeta, poolIsPerp
        );

        (bool decoded, string memory answer) = ArenaUtils.decodeStringResult(responses[0].result);
        (bool inSet, uint8 chosen) = decoded
            ? ArenaUtils.matchAction(legal, answer, ArenaUtils.vocabFor(cPools, poolLabel, poolIsPerp))
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

        uint8 slot;
        if      (action == ArenaTypes.FighterAction.BuyWBTC)  { slot = 1; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellWBTC) { slot = 1; isBid = false; }
        else if (action == ArenaTypes.FighterAction.BuyWETH)  { slot = 0; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellWETH) { slot = 0; isBid = false; }
        else if (action == ArenaTypes.FighterAction.BuySOMI)  { slot = 2; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellSOMI) { slot = 2; isBid = false; }
        else return (false, 0);
        pool = mp[slot];

        // Reject trades on pools not active for this duel's tier.
        //
        // The tier bit comes from the slot the action already picked, not from
        // looking the address back up in the registered pool sets. The lookup
        // could only recognise addresses Arena was deployed or configured with,
        // so an event desk — which is registered per window and changes every few
        // minutes — came back as "not a pool at all" and every trade in an event
        // duel was rejected. Reading the slot directly cannot fail that way, and
        // the address is still checked against the known sets before any order is
        // placed (see _requireValidPool in _placeOrderForFighter).
        uint8 bit = uint8(1) << slot;   // 0x01 WETH, 0x02 WBTC, 0x04 SOMI
        if (duel.poolMask & bit == 0) {
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
        bool    isPerp = poolIsPerp[pool];

        if (isPerp) {
            // ONE smallest position, either direction, every time.
            //
            // Both of the balance gates below are meaningless here and would be
            // actively wrong. A perps fighter's spending power is not a quote balance
            // in a vault — it is margin health held by the protocol, which is already
            // what decided whether this action was offered at all (see
            // `perpTradability`). And a sell does not need a holding to sell: that is
            // the entire point of this market, and reading `bal.baseTokenAmount` here
            // would refuse every short.
            //
            // Fixed size rather than "as much as it can afford" so the fight stays
            // legible: every move is one step in a direction, and a fighter cannot
            // put its whole budget on one turn and have nothing left to play with.
            desired = meta.minQuantity;
        } else if (isBid) {
            if (bal.quoteTokenAmount == 0) {
                _reject(pool, fighterId, duelId, isBid, price, 0, 1, "no quote balance");
                return (false, 0);
            }
            // The same question the offer gate asked, answered by the same code.
            // Asking it differently here is what produced a refusal on every buy
            // after the gate was widened: the gate counted this contract's own
            // balance and this check still looked only at the venue's deposit.
            //
            // Written as one call with no locals on purpose — this function is one
            // local away from Solidity's stack limit, so the two variables that used
            // to be here are a cost as well as a duplication.
            if (!ArenaUtils.canFundBuy(pool, USDSO, (meta.minQuantity * price) / baseUnit)) {
                _reject(pool, fighterId, duelId, isBid, price, 0, 1, "cannot fund min cost");
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

        // The fighter's identity rides on `userData`, which Arena hard-coded to zero
        // until now. A perp desk needs it because all six desks converge on ONE
        // account per fighter, so the desk cannot work out whose order this is from
        // its own address. Left at zero for spot and events, where nothing reads it
        // and a change would be a change for its own sake.
        uint64 userData = isPerp ? uint64((duelId << 8) | uint256(fighterId)) : 0;

        // A SELL has to hand real tokens over, and the venue takes them by
        // `transferFrom` out of THIS contract's balance — which is where it delivered
        // them when the buy filled, not into any vault. Without an allowance that
        // transfer reverts, so every sell on every spot market failed and a fighter
        // could buy an asset and never realise anything on it.
        //
        // Granted per order and for exactly this quantity, so no standing allowance is
        // left behind for a pool that is later re-pointed.
        if (!isPerp && !isBid) _approveBaseForSale(pool, quantity);

        // The matching allowance for a BUY is granted inside `_placeOrderForFighter`,
        // not here: this function is one local variable away from Solidity's stack limit
        // and another call at this depth stops it compiling. See the note there.

        (ok, orderId) = _placeOrderForFighter(duelId, fighterId, pool, isBid, price, quantity, 1, 3600, userData);

        // A perps position is held by the protocol, against the fighter's own
        // address, and scored as account equity at the end. Mirroring it into the
        // virtual ledger would be keeping a second set of books that can only
        // disagree with the first — and the quote side of that ledger is what
        // `recoverFunds` pays the creator from, so writing to it here would quietly
        // change what the players get back.
        if (ok && !isPerp) {
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


    /// @dev Let `pool` take `quantity` of its own base asset from this contract, for
    ///      one sell. Best-effort: a pool that will not name its base asset, or a
    ///      token that refuses the approval, leaves the order to fail on its own
    ///      rather than reverting the turn and costing the player their fight.
    ///
    ///      A base asset with no code is the native coin, which cannot be approved at
    ///      all — selling it needs value sent with the order, which this path does not
    ///      do. `tradability` already declines to offer that sell.
    /// @dev Is this market's asset the chain's own coin? A base address with no code
    ///      behind it is the coin itself, not a token.
    function _baseIsNative(address pool) internal view returns (bool) {
        try ISpotPool(pool).getPoolParams() returns (
            address b, address, uint256, uint256, uint256, uint256, uint256
        ) {
            return b != address(0) && b.code.length == 0;
        } catch { return false; }
    }

    function _approveBaseForSale(address pool, uint256 quantity) internal {
        address baseToken;
        try ISpotPool(pool).getPoolParams() returns (
            address b, address, uint256, uint256, uint256, uint256, uint256
        ) { baseToken = b; } catch { return; }
        if (baseToken == address(0) || baseToken.code.length == 0) return;
        // Zero first, for tokens that refuse a non-zero-to-non-zero change.
        try IERC20Minimal(baseToken).approve(pool, 0) returns (bool) {} catch { return; }
        try IERC20Minimal(baseToken).approve(pool, quantity) returns (bool) {} catch { return; }
    }

    function _placeOrderForFighter(
        uint256 duelId,
        uint8   fighterId,
        address pool,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint8   orderType,
        uint64  expireOffsetSec,
        uint64  userData
    ) internal returns (bool ok, uint128 orderId) {
        _requireValidPool(pool);
        if (expireOffsetSec == 0 || expireOffsetSec > MAX_EXPIRE_OFFSET_SEC) revert ArenaTypes.InvalidExpiry();
        if (orderType > 3) revert ArenaTypes.BadOrderType();

        uint64 expireTimestampNs = (uint64(block.timestamp) + expireOffsetSec) * 1_000_000_000;

        // Let the venue take the money for a buy out of this contract's own balance.
        //
        // Why this exists is a question rather than a known fault. Today a buy is paid
        // from what was DEPOSITED to the pool: measured on duel 38, the WETH deposit
        // fell 200.09 → 173.34 USDso, matching fourteen buys to the penny. Nothing ever
        // refills that deposit — a fill is delivered to this contract's balance and a
        // sale's proceeds land there too — so it drains to zero and then every buy is
        // refused, which is exactly what happened before it was seeded again by hand.
        //
        // The protocol's own documentation says these pools take payment straight from
        // the caller's balance by `transferFrom`, with no deposit step at all, and the
        // sell path proves that mechanism works here. If it works for the quote too,
        // the deposit is legacy and the drain simply stops. If the venue keeps
        // preferring the deposit, this allowance is inert and costs nothing.
        //
        // So it is both the fix and the measurement: watch whether the deposit still
        // falls across a fight — `scripts/check-arena-vaults.ts` reports both pots.
        //
        // The offer gate is deliberately NOT widened to match. It still requires the
        // DEPOSIT to cover a lot, because offering buys before we know the venue will
        // bill this contract directly would offer orders that revert, and a reverted
        // order costs the fighter its turn — the very thing that gate exists to
        // prevent. Widen it only once this measurement says the balance is enough.
        //
        // Best-effort, per order, for exactly this order's cost: a token that refuses
        // the approval leaves the order to fail on its own rather than reverting the
        // turn, and no standing allowance survives for a pool that is later re-pointed.
        if (isBid && !poolIsPerp[pool]) {
            uint256 cost = (price * quantity) / (10 ** uint256(poolMeta[pool].baseDecimals));
            if (cost > 0) {
                try IERC20Minimal(USDSO).approve(pool, 0) returns (bool) {} catch {}
                try IERC20Minimal(USDSO).approve(pool, cost) returns (bool) {} catch {}
            }
        }

        // Sent as a RAW call rather than through the typed interface, for two reasons
        // that turned out to be the same reason.
        //
        // The typed declaration is non-payable, so it cannot carry value — and one
        // market's asset is the chain's own COIN, where selling means sending the coin
        // WITH the order. That sale was refused outright for months because of this.
        //
        // And separately, measured 2026-08-20: an identical order with identical
        // arguments was refused through the typed interface and filled through a raw
        // encode, every other parameter reproduced and eliminated one at a time. The
        // interface in this repo is a reconstruction; this encoding is the one the
        // deployed venue demonstrably accepts.
        {
            uint256 value = 0;
            if (!isBid && !poolIsPerp[pool] && _baseIsNative(pool)) {
                // Only ever the order's own quantity, and only what sits above the
                // fuel reserve — the gate already refused otherwise, and this is the
                // second line of defence rather than the first.
                value = quantity;
                if (address(this).balance < value) {
                    _reject(pool, fighterId, duelId, isBid, price, quantity, orderType, "not enough coin to deliver");
                    return (false, 0);
                }
            }
            (bool sent, bytes memory ret) = pool.call{value: value}(
                abi.encodeWithSignature(
                    "placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)",
                    isBid, userData, price, quantity, expireTimestampNs, orderType, uint8(0), address(0), uint96(0)
                )
            );
            if (!sent || ret.length != 64) {
                _reject(pool, fighterId, duelId, isBid, price, quantity, orderType, "pool reverted");
                return (false, 0);
            }
            (bool success, uint128 returnedId) = abi.decode(ret, (bool, uint128));
            if (!success) {
                _reject(pool, fighterId, duelId, isBid, price, quantity, orderType, "silent reject");
                return (false, 0);
            }
            ok = true;
            orderId = returnedId;
        }

        emit ArenaTypes.OrderPlaced(pool, fighterId, duelId, orderId, isBid, price, quantity, orderType);
        // FOK orders (orderType=1) from _executeFighterAction update fighter balances
        // at the call site — this function only places the order and emits.
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

    // ─── Debug / test helpers (testnet only) ─────────────────────────────────

    function testRequestFighterMove(uint256 duelId, uint8 fighterId) external onlyOwner {
        _requestFighterMove(duelId, fighterId);
    }
}
