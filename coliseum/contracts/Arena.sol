// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ArenaVault.sol";
import "./lib/ArenaTypes.sol";
import "./lib/ArenaUtils.sol";
import "./interfaces/IFighterRegistry.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/ISomniaAgents.sol";

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

    address public immutable PLATFORM_ADDR;
    IFighterRegistry public immutable registry;
    uint256 public TURN_INTERVAL_BLOCKS;

    // ─── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => ArenaTypes.Duel) public duels;
    uint256 public nextDuelId = 1;
    uint256 public activeDuelId;

    // poolAddress → duelId → fighterId → balance
    mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) public fighterBalances;

    mapping(uint256 => ArenaTypes.PendingTurn) public pendingTurns;  // requestId → turn

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
        if (msg.value < REACTIVITY_FUND_MIN) revert ArenaTypes.ReactivityUnderfunded();
        registry            = IFighterRegistry(_registry);
        PLATFORM_ADDR       = _platform;
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;

        _cachePoolMeta(_poolWeth, _baseDecimals[0]);
        _cachePoolMeta(_poolWbtc, _baseDecimals[1]);
        _cachePoolMeta(_poolSomi, _baseDecimals[2]);

        subscriptionId = _subscribeReactivity();
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
        if (activeDuelId == 0) return;
        _runTurn();
    }

    function turn() external {
        _runTurn();
    }

    function _runTurn() internal {
        if (activeDuelId == 0) return;
        ArenaTypes.Duel storage duel = duels[activeDuelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) return;
        if (block.number < duel.lastTurnBlock + TURN_INTERVAL_BLOCKS) return;
        if (duel.completedCallbacks >= duel.turns * 2) return;
        duel.lastTurnBlock = block.number;
        _requestFighterMove(activeDuelId, duel.fighterA);
        _requestFighterMove(activeDuelId, duel.fighterB);
        emit ArenaTypes.TurnAdvanced(activeDuelId, duel.completedCallbacks, block.number);
    }

    // ─── Duel lifecycle ───────────────────────────────────────────────────────

    /// @notice Start a new duel. Caller deposits the minimum required USDso + platform fee.
    /// @param fighterA  Fighter index (0–5 from FighterRegistry)
    /// @param fighterB  Fighter index (0–5, must differ from fighterA)
    /// @param turns     Duel length: 3, 6, 9, or 15
    function startDuel(
        uint8  fighterA,
        uint8  fighterB,
        uint16 turns
    ) external returns (uint256 duelId) {
        if (activeDuelId != 0 && duels[activeDuelId].status != ArenaTypes.DuelStatus.Resolved)
            revert ArenaTypes.DuelAlreadyActive();

        if (!ArenaUtils.isValidTurnCount(turns)) revert ArenaTypes.InvalidTurnCount();

        uint8 count = registry.FIGHTER_COUNT();
        if (fighterA == fighterB || fighterA >= count || fighterB >= count)
            revert ArenaTypes.InvalidFighterPair();

        // Compute minimum deposit for this tier and pull from caller.
        uint256 minDeposit = ArenaUtils.minDepositFor(
            turns, POOL_WETH, POOL_WBTC, POOL_SOMI, poolMeta
        );
        // If no book data (local hardhat), minDeposit is 0. Use a floor of 2 USDso per fighter
        // so the duel pot is non-zero even without live price feeds.
        if (minDeposit == 0) minDeposit = 2e18;
        uint256 required = minDeposit + PLATFORM_FEE;

        uint256 provided = IERC20Minimal(USDSO).allowance(msg.sender, address(this));
        if (provided < required) revert ArenaTypes.DepositTooLow(required, provided);

        bool ok = IERC20Minimal(USDSO).transferFrom(msg.sender, address(this), required);
        if (!ok) revert ArenaTypes.TransferFailed();

        // Platform fee stays in contract; remainder is the duel pot.
        accruedFees += PLATFORM_FEE;
        uint256 pot = required - PLATFORM_FEE;
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
            lastAction:              [uint8(0), uint8(0)]
        });
        activeDuelId = duelId;

        // Seed virtual quote balance only on active pools for this tier.
        address[3] memory pools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        for (uint256 i = 0; i < 3; i++) {
            if (mask & bits[i] == 0) continue;
            fighterBalances[pools[i]][duelId][fighterA].quoteTokenAmount = initialUsdsoPerFighter;
            fighterBalances[pools[i]][duelId][fighterB].quoteTokenAmount = initialUsdsoPerFighter;
        }

        emit ArenaTypes.DuelStarted(duelId, fighterA, fighterB, msg.sender, turns, mask, block.number);
    }

    /// @notice Finalize a completed duel. Anyone can call once all callbacks are in.
    function finalizeDuel(uint256 duelId) external {
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) revert ArenaTypes.DuelNotActive();
        if (duel.completedCallbacks < duel.turns * 2) revert ArenaTypes.DuelNotReadyToFinalize();
        _resolveDuel(duelId, duel);
    }

    /// @notice Safety valve: owner can force-resolve a duel that has been stuck for
    ///         EMERGENCY_FINALIZE_BLOCKS without a turn advancing. Protects depositors
    ///         from funds being locked indefinitely if the LLM platform goes silent.
    function emergencyFinalize(uint256 duelId) external onlyOwner {
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Active) revert ArenaTypes.DuelNotActive();
        if (block.number < duel.lastTurnBlock + EMERGENCY_FINALIZE_BLOCKS)
            revert ArenaTypes.DuelNotReadyToFinalize();
        _resolveDuel(duelId, duel);
    }

    function _resolveDuel(uint256 duelId, ArenaTypes.Duel storage duel) internal {
        duel.status = ArenaTypes.DuelStatus.Finalizing;

        address[3] memory pools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        uint256 valueA = 0;
        uint256 valueB = 0;

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            address pool = pools[i];
            uint256 markPrice = ArenaUtils.midMarkPrice(pool);
            uint256 baseUnit  = 10 ** uint256(poolMeta[pool].baseDecimals);
            ArenaTypes.PoolBalance memory balA = fighterBalances[pool][duelId][duel.fighterA];
            ArenaTypes.PoolBalance memory balB = fighterBalances[pool][duelId][duel.fighterB];
            valueA += balA.quoteTokenAmount + (balA.baseTokenAmount * markPrice / baseUnit);
            valueB += balB.quoteTokenAmount + (balB.baseTokenAmount * markPrice / baseUnit);
        }

        uint8 winner = valueA >= valueB ? duel.fighterA : duel.fighterB;
        duel.status = ArenaTypes.DuelStatus.Resolved;
        activeDuelId = 0;
        emit ArenaTypes.DuelResolved(duelId, winner, valueA, valueB);
    }

    /// @notice Duel creator withdraws their USDso back after the duel resolves.
    ///         Pulls withdrawable balance from each active pool back into Arena, then
    ///         transfers the full recovered amount to the creator.
    function recoverFunds(uint256 duelId) external {
        ArenaTypes.Duel storage duel = duels[duelId];
        if (duel.status != ArenaTypes.DuelStatus.Resolved) revert ArenaTypes.DuelNotResolved();
        if (duel.creator != msg.sender) revert ArenaTypes.NotDuelCreator();

        address[3] memory pools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        uint256 recovered = 0;

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            address pool = pools[i];
            uint256 withdrawable = ISpotPool(pool).getWithdrawableBalance(address(this), USDSO);
            if (withdrawable == 0) continue;
            ISpotPool(pool).withdraw(USDSO, withdrawable);
            recovered += withdrawable;
        }

        if (recovered == 0) revert ArenaTypes.NothingToRecover();

        bool ok = IERC20Minimal(USDSO).transfer(msg.sender, recovered);
        if (!ok) revert ArenaTypes.TransferFailed();

        emit ArenaTypes.DuelFundsRecovered(duelId, msg.sender, recovered);
    }

    // ─── LLM request / response ───────────────────────────────────────────────

    function _requestFighterMove(uint256 duelId, uint8 fighterId) internal returns (uint256 requestId) {
        IFighterRegistry.Fighter memory f = registry.getFighter(fighterId);
        string memory marketSummary = ArenaUtils.buildMarketSummary(
            duelId, fighterId, duels[duelId],
            POOL_WETH, POOL_WBTC, POOL_SOMI,
            fighterBalances, poolMeta
        );
        bytes memory payload = abi.encodeWithSelector(
            ILLMInferenceAgent.inferNumber.selector,
            marketSummary,
            f.systemPrompt,
            int256(0), int256(6),
            false
        );

        IAgentRequester platform = IAgentRequester(PLATFORM_ADDR);
        uint256 deposit = platform.getRequestDeposit() + FIGHTER_DEPOSIT_TOPUP * 3;
        if (address(this).balance < deposit) revert ArenaTypes.InsufficientStt();
        requestId = platform.createRequest{value: deposit}(
            LLM_AGENT_ID,
            address(this),
            this.handleFighterResponse.selector,
            payload
        );

        pendingTurns[requestId] = ArenaTypes.PendingTurn({
            duelId:   duelId,
            fighterId: fighterId,
            deadline: block.timestamp + FIGHTER_REQUEST_DEADLINE_SEC,
            exists:   true
        });
        emit ArenaTypes.FighterMoveRequested(duelId, fighterId, requestId);
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
        if (responses[0].result.length != 32) {
            duels[pt.duelId].completedCallbacks += 1;
            emit ArenaTypes.FighterMoveFailed(pt.duelId, pt.fighterId, "bad encoding");
            return;
        }
        int256 raw = abi.decode(responses[0].result, (int256));
        if (raw < 0 || raw > 6) {
            duels[pt.duelId].completedCallbacks += 1;
            emit ArenaTypes.FighterMoveFailed(pt.duelId, pt.fighterId, "out of range");
            return;
        }

        ArenaTypes.FighterAction action = ArenaTypes.FighterAction(uint8(uint256(raw)));
        (bool ok, uint128 orderId) = _executeFighterAction(pt.duelId, pt.fighterId, action);
        duels[pt.duelId].completedCallbacks += 1;
        if (!ok) {
            emit ArenaTypes.FighterMoveFailed(pt.duelId, pt.fighterId, "exec failed");
            return;
        }
        duels[pt.duelId].lastAction[pt.fighterId] = uint8(action);
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

        if      (action == ArenaTypes.FighterAction.BuyWBTC)  { pool = POOL_WBTC; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellWBTC) { pool = POOL_WBTC; isBid = false; }
        else if (action == ArenaTypes.FighterAction.BuyWETH)  { pool = POOL_WETH; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellWETH) { pool = POOL_WETH; isBid = false; }
        else if (action == ArenaTypes.FighterAction.BuySOMI)  { pool = POOL_SOMI; isBid = true;  }
        else if (action == ArenaTypes.FighterAction.SellSOMI) { pool = POOL_SOMI; isBid = false; }
        else return (false, 0);

        // Reject trades on pools not active for this duel's tier.
        ArenaTypes.Duel storage duel = duels[duelId];
        uint8 bit = _poolBit(pool);
        if (bit == 0 || duel.poolMask & bit == 0) {
            emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, 0, 0, 1, "pool not in tier");
            return (false, 0);
        }

        OrderBookLevel[] memory levels;
        try ISpotPool(pool).getBookLevels(!isBid, 1) returns (OrderBookLevel[] memory l) {
            levels = l;
        } catch {
            emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, 0, 0, 1, "book read failed");
            return (false, 0);
        }
        if (levels.length == 0 || levels[0].quantity == 0) {
            emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, 0, 0, 1, "empty book");
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
                emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "no quote balance");
                return (false, 0);
            }
            uint256 minCost = (meta.minQuantity * price) / baseUnit;
            uint256 vaultQuote = ISpotPool(pool).getWithdrawableBalance(address(this), USDSO);
            if (vaultQuote < minCost) {
                emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "vault below min cost");
                return (false, 0);
            }
            desired = meta.minQuantity;
        } else {
            if (bal.baseTokenAmount == 0) {
                emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "no base balance");
                return (false, 0);
            }
            desired = bal.baseTokenAmount;
        }

        uint256 quantity = desired < available ? desired : available;
        if (meta.lotSize > 0)    quantity = (quantity / meta.lotSize) * meta.lotSize;
        if (quantity == 0) {
            emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "zero quantity");
            return (false, 0);
        }
        if (quantity < meta.minQuantity) {
            emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, quantity, 1, "below minQuantity");
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
                emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, quantity, orderType, "silent reject");
                return (false, 0);
            }
            ok = true;
            orderId = returnedId;
        } catch {
            emit ArenaTypes.OrderRejected(pool, fighterId, duelId, isBid, price, quantity, orderType, "pool reverted");
            return (false, 0);
        }

        emit ArenaTypes.OrderPlaced(pool, fighterId, duelId, orderId, isBid, price, quantity, orderType);

        if (orderType == 3) {
            if (isBid) {
                fighterBalances[pool][duelId][fighterId].quoteTokenAmount += price * quantity / 1e18;
            } else {
                fighterBalances[pool][duelId][fighterId].baseTokenAmount += quantity;
            }
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _poolBit(address pool) internal view returns (uint8) {
        if (pool == POOL_WETH) return ArenaTypes.POOL_BIT_WETH;
        if (pool == POOL_WBTC) return ArenaTypes.POOL_BIT_WBTC;
        if (pool == POOL_SOMI) return ArenaTypes.POOL_BIT_SOMI;
        return 0;
    }

    /// @notice Returns the minimum USDso deposit (excluding platform fee) for a turn tier.
    function minDepositFor(uint16 turns) external view returns (uint256) {
        return ArenaUtils.minDepositFor(turns, POOL_WETH, POOL_WBTC, POOL_SOMI, poolMeta);
    }

    // ─── Debug / test helpers (testnet only) ─────────────────────────────────

    function testRequestFighterMove(uint256 duelId, uint8 fighterId) external onlyOwner returns (uint256) {
        return _requestFighterMove(duelId, fighterId);
    }

    function debugPlaceOrder(
        uint256 duelId,
        uint8   fighterId,
        address pool,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint8   orderType,
        uint64  expireOffsetSec
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        return _placeOrderForFighter(duelId, fighterId, pool, isBid, price, quantity, orderType, expireOffsetSec);
    }

    function cancelOrder(address pool, uint128 orderId) external onlyOwner {
        _requireValidPool(pool);
        ISpotPool(pool).cancelOrder(orderId);
    }
}
