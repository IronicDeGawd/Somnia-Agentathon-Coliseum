// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../lib/ArenaUtils.sol";
import "../interfaces/IFighterRegistry.sol";
import "../interfaces/ISpotPool.sol";
import "../interfaces/ISomniaAgents.sol";

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
