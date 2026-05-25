// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IFighterRegistry.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/ISomniaAgents.sol";
import "./interfaces/ISomniaReactivityPrecompile.sol";

contract Arena {
    error NotOwner();
    error ZeroAmount();
    error TransferFailed();
    error ApproveFailed();
    error InvalidPool(address pool);
    error InvalidExpiry();
    error BadOrderType();
    error OnlyPlatform();
    error UnknownRequest();
    error RequestTimedOut();
    error NotYetExpired();
    error InsufficientStt();
    error DuelAlreadyActive();
    error DuelNotActive();
    error DuelNotReadyToFinalize();
    error InvalidFighterPair();
    error InvalidPoolForDuel();
    error ReactivityUnderfunded();

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant REACTIVITY_FUND_MIN = 33 ether;
    uint256 public subscriptionId;

    uint64 public constant MAX_EXPIRE_OFFSET_SEC = 7 days;

    address public immutable PLATFORM_ADDR;
    uint256 public constant LLM_AGENT_ID = 12847293847561029384;
    uint256 public constant FIGHTER_DEPOSIT_TOPUP = 0.07 ether;  // per-agent budget × 3 validators
    uint256 public constant FIGHTER_REQUEST_DEADLINE_SEC = 15 minutes;

    enum FighterAction { Hold, BuyWBTC, SellWBTC, BuyWETH, SellWETH, BuySOMI, SellSOMI }

    struct PendingTurn {
        uint256 duelId;
        uint8   fighterId;
        uint256 deadline;
        bool    exists;
    }
    mapping(uint256 => PendingTurn) public pendingTurns;  // requestId → turn

    event PoolsFunded(uint256 usdsoPerPool, uint256 totalDeposited);
    event SubscriptionSkipped(string reason);
    event OrderPlaced(
        address indexed pool,
        uint8 indexed fighterId,
        uint256 duelId,
        uint128 orderId,
        bool isBid,
        uint256 price,
        uint256 quantity,
        uint8 orderType
    );
    event OrderRejected(
        address indexed pool,
        uint8 indexed fighterId,
        uint256 duelId,
        bool isBid,
        uint256 price,
        uint256 quantity,
        uint8 orderType,
        string reason
    );
    event FighterMoveRequested(uint256 indexed duelId, uint8 indexed fighterId, uint256 indexed requestId);
    event FighterMove(uint256 indexed duelId, uint8 indexed fighterId, FighterAction action, uint128 orderId);
    event FighterMoveFailed(uint256 indexed duelId, uint8 indexed fighterId, string reason);
    event DuelStarted(uint256 indexed duelId, uint8 fighterA, uint8 fighterB, address pool, uint256 startBlock);
    event TurnAdvanced(uint256 indexed duelId, uint16 completedCallbacks, uint256 blockNumber);
    event DuelResolved(uint256 indexed duelId, uint8 indexed winnerId, uint256 fighterAValueUsdso, uint256 fighterBValueUsdso);

    enum DuelStatus { None, Pending, Active, Finalizing, Resolved }

    struct Duel {
        uint8       fighterA;
        uint8       fighterB;
        uint256     startBlock;
        uint256     lastTurnBlock;
        uint16      completedCallbacks;
        DuelStatus  status;
        address     pool;
        uint256     initialUsdsoPerFighter;
    }

    uint16 public constant TURNS_PER_DUEL = 15;
    uint256 public TURN_INTERVAL_BLOCKS;

    mapping(uint256 => Duel) public duels;
    uint256 public nextDuelId = 1;
    uint256 public activeDuelId;

    address public immutable USDSO;
    address public immutable POOL_WETH;
    address public immutable POOL_WBTC;
    address public immutable POOL_SOMI;
    address public owner;
    IFighterRegistry public immutable registry;

    struct PoolBalance {
        uint256 baseTokenAmount;
        uint256 quoteTokenAmount;
    }

    // poolAddress => duelId => fighterId => balance
    mapping(address => mapping(uint256 => mapping(uint8 => PoolBalance))) public fighterBalances;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _registry,
        address _usdso,
        address _poolWeth,
        address _poolWbtc,
        address _poolSomi,
        address _platform,
        uint256 _turnIntervalBlocks
    ) payable {
        if (msg.value < REACTIVITY_FUND_MIN) revert ReactivityUnderfunded();
        registry = IFighterRegistry(_registry);
        USDSO = _usdso;
        POOL_WETH = _poolWeth;
        POOL_WBTC = _poolWbtc;
        POOL_SOMI = _poolSomi;
        PLATFORM_ADDR = _platform;
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;
        owner = msg.sender;

        ISomniaReactivityPrecompile.SubscriptionData memory data = ISomniaReactivityPrecompile.SubscriptionData({
            eventTopics: [
                keccak256("BlockTick(uint64)"),
                bytes32(0),
                bytes32(0),
                bytes32(0)
            ],
            origin: address(0),
            caller: address(0),
            emitter: SOMNIA_REACTIVITY_PRECOMPILE,
            handlerContractAddress: address(this),
            handlerFunctionSelector: this.onEvent.selector,
            priorityFeePerGas: 2_000_000_000,
            maxFeePerGas: 20_000_000_000,
            gasLimit: 3_000_000,
            isGuaranteed: false,
            isCoalesced: false
        });

        bytes memory callData = abi.encodeWithSelector(
            ISomniaReactivityPrecompile.subscribe.selector,
            data
        );
        (bool ok, bytes memory ret) = SOMNIA_REACTIVITY_PRECOMPILE.call(callData);
        if (ok && ret.length >= 32) {
            subscriptionId = abi.decode(ret, (uint256));
        } else {
            subscriptionId = 0;
            emit SubscriptionSkipped("precompile unavailable");
        }
    }

    receive() external payable {}

    function onEvent(address /*emitter*/, bytes32[] calldata eventTopics, bytes calldata /*data*/) external {
        if (msg.sender != SOMNIA_REACTIVITY_PRECOMPILE) return;
        if (eventTopics.length < 2) return;
        uint64 blockNumber = uint64(uint256(eventTopics[1]));
        if (blockNumber % TURN_INTERVAL_BLOCKS != 0) return;
        if (activeDuelId == 0) return;
        _runTurn();
    }

    function _runTurn() internal {
        if (activeDuelId == 0) return;
        Duel storage duel = duels[activeDuelId];
        if (duel.status != DuelStatus.Active) return;
        if (block.number < duel.lastTurnBlock + TURN_INTERVAL_BLOCKS) return;
        if (duel.completedCallbacks >= TURNS_PER_DUEL * 2) return;
        duel.lastTurnBlock = block.number;
        _requestFighterMove(activeDuelId, duel.fighterA);
        _requestFighterMove(activeDuelId, duel.fighterB);
    }

    function _placeOrderForFighter(
        uint256 duelId,
        uint8 fighterId,
        address pool,
        bool isBid,
        uint256 price,
        uint256 quantity,
        uint8 orderType,
        uint64 expireOffsetSec
    ) internal returns (bool ok, uint128 orderId) {
        if (pool != POOL_WETH && pool != POOL_WBTC && pool != POOL_SOMI) revert InvalidPool(pool);
        if (expireOffsetSec == 0) revert InvalidExpiry();
        if (expireOffsetSec > MAX_EXPIRE_OFFSET_SEC) revert InvalidExpiry();
        if (orderType > 3) revert BadOrderType();

        uint64 expireTimestampNs = (uint64(block.timestamp) + expireOffsetSec) * 1_000_000_000;

        try ISpotPool(pool).placeOrder(isBid, 0, price, quantity, expireTimestampNs, orderType, 0, address(0), 0) returns (bool success, uint128 returnedId) {
            if (!success) {
                emit OrderRejected(pool, fighterId, duelId, isBid, price, quantity, orderType, "silent reject");
                return (false, 0);
            }
            ok = true;
            orderId = returnedId;
        } catch {
            emit OrderRejected(pool, fighterId, duelId, isBid, price, quantity, orderType, "pool reverted");
            return (false, 0);
        }

        emit OrderPlaced(pool, fighterId, duelId, orderId, isBid, price, quantity, orderType);

        // PostOnly path: debit internal balance for resting orders only
        if (orderType == 3) {
            if (isBid) {
                // quote (USDso) locked = price * quantity / 1e18
                fighterBalances[pool][duelId][fighterId].quoteTokenAmount += price * quantity / 1e18;
            } else {
                fighterBalances[pool][duelId][fighterId].baseTokenAmount += quantity;
            }
        }
    }

    function _buildMarketSummary(uint256 duelId) internal pure returns (string memory) {
        // Phase 5 will enrich this with live price/volume data
        bytes memory buf = new bytes(32);
        uint256 tmp = duelId;
        uint256 len = 0;
        if (tmp == 0) {
            buf[0] = "0";
            len = 1;
        } else {
            while (tmp > 0) {
                buf[len++] = bytes1(uint8(48 + (tmp % 10)));
                tmp /= 10;
            }
            // reverse
            for (uint256 i = 0; i < len / 2; i++) {
                bytes1 t = buf[i];
                buf[i] = buf[len - 1 - i];
                buf[len - 1 - i] = t;
            }
        }
        bytes memory numBytes = new bytes(len);
        for (uint256 i = 0; i < len; i++) numBytes[i] = buf[i];
        return string.concat("duel ", string(numBytes), " active");
    }

    function _requestFighterMove(uint256 duelId, uint8 fighterId) internal returns (uint256 requestId) {
        IFighterRegistry.Fighter memory f = registry.getFighter(fighterId);
        string memory marketSummary = _buildMarketSummary(duelId);
        bytes memory payload = abi.encodeWithSelector(
            ILLMInferenceAgent.inferNumber.selector,
            marketSummary,
            f.systemPrompt,
            int256(0), int256(6),  // min/max action
            false                  // no chain-of-thought (cheaper)
        );

        IAgentRequester platform = IAgentRequester(PLATFORM_ADDR);
        uint256 deposit = platform.getRequestDeposit() + FIGHTER_DEPOSIT_TOPUP * 3;
        if (address(this).balance < deposit) revert InsufficientStt();
        requestId = platform.createRequest{value: deposit}(
            LLM_AGENT_ID,
            address(this),
            this.handleFighterResponse.selector,
            payload
        );

        pendingTurns[requestId] = PendingTurn({
            duelId: duelId,
            fighterId: fighterId,
            deadline: block.timestamp + FIGHTER_REQUEST_DEADLINE_SEC,
            exists: true
        });
        emit FighterMoveRequested(duelId, fighterId, requestId);
    }

    function _executeFighterAction(
        uint256 duelId,
        uint8 fighterId,
        FighterAction action
    ) internal returns (bool ok, uint128 orderId) {
        if (action == FighterAction.Hold) {
            return (true, 0);
        }

        address pool;
        bool isBid;

        if (action == FighterAction.BuyWBTC) {
            pool = POOL_WBTC; isBid = true;
        } else if (action == FighterAction.SellWBTC) {
            pool = POOL_WBTC; isBid = false;
        } else if (action == FighterAction.BuyWETH) {
            pool = POOL_WETH; isBid = true;
        } else if (action == FighterAction.SellWETH) {
            pool = POOL_WETH; isBid = false;
        } else if (action == FighterAction.BuySOMI) {
            pool = POOL_SOMI; isBid = true;
        } else if (action == FighterAction.SellSOMI) {
            pool = POOL_SOMI; isBid = false;
        } else {
            return (false, 0);
        }

        // Read the opposite side of the book to price an at-market FOK.
        // FOK guarantees full fill or full revert — no partial-fill accounting drift.
        OrderBookLevel[] memory levels;
        try ISpotPool(pool).getBookLevels(!isBid, 1) returns (OrderBookLevel[] memory l) {
            levels = l;
        } catch {
            emit OrderRejected(pool, fighterId, duelId, isBid, 0, 0, 1, "book read failed");
            return (false, 0);
        }
        if (levels.length == 0 || levels[0].quantity == 0) {
            emit OrderRejected(pool, fighterId, duelId, isBid, 0, 0, 1, "empty book");
            return (false, 0);
        }

        uint256 price = levels[0].price;
        uint256 available = levels[0].quantity;

        PoolBalance storage bal = fighterBalances[pool][duelId][fighterId];
        uint256 desired;
        if (isBid) {
            if (bal.quoteTokenAmount == 0) {
                emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "no quote balance");
                return (false, 0);
            }
            desired = (bal.quoteTokenAmount * 1e18) / price;
        } else {
            if (bal.baseTokenAmount == 0) {
                emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "no base balance");
                return (false, 0);
            }
            desired = bal.baseTokenAmount;
        }

        uint256 quantity = desired < available ? desired : available;
        if (quantity == 0) {
            emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "zero quantity");
            return (false, 0);
        }

        // orderType 1 = FOK
        (ok, orderId) = _placeOrderForFighter(duelId, fighterId, pool, isBid, price, quantity, 1, 3600);
        if (ok) {
            uint256 quoteCost = (price * quantity) / 1e18;
            if (isBid) {
                if (quoteCost > bal.quoteTokenAmount) quoteCost = bal.quoteTokenAmount;
                bal.quoteTokenAmount -= quoteCost;
                bal.baseTokenAmount += quantity;
            } else {
                if (quantity > bal.baseTokenAmount) {
                    bal.baseTokenAmount = 0;
                } else {
                    bal.baseTokenAmount -= quantity;
                }
                bal.quoteTokenAmount += quoteCost;
            }
        }
        return (ok, orderId);
    }

    function handleFighterResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory  /* details */
    ) external {
        if (msg.sender != PLATFORM_ADDR) revert OnlyPlatform();
        PendingTurn memory pt = pendingTurns[requestId];
        if (!pt.exists) {
            emit FighterMoveFailed(0, 0, "unknown request");
            return;
        }
        delete pendingTurns[requestId];

        if (status != ResponseStatus.Success || responses.length == 0) {
            duels[pt.duelId].completedCallbacks += 1;
            emit FighterMoveFailed(pt.duelId, pt.fighterId, "no consensus");
            return;
        }

        if (responses[0].result.length != 32) {
            duels[pt.duelId].completedCallbacks += 1;
            emit FighterMoveFailed(pt.duelId, pt.fighterId, "bad encoding");
            return;
        }
        int256 raw = abi.decode(responses[0].result, (int256));
        if (raw < 0 || raw > 6) {
            duels[pt.duelId].completedCallbacks += 1;
            emit FighterMoveFailed(pt.duelId, pt.fighterId, "out of range");
            return;
        }
        FighterAction action = FighterAction(uint8(uint256(raw)));
        (bool ok, uint128 orderId) = _executeFighterAction(pt.duelId, pt.fighterId, action);
        duels[pt.duelId].completedCallbacks += 1;
        if (!ok) {
            emit FighterMoveFailed(pt.duelId, pt.fighterId, "exec failed");
            return;
        }
        emit FighterMove(pt.duelId, pt.fighterId, action, orderId);
    }

    function expireTurn(uint256 requestId) external onlyOwner {
        PendingTurn memory pt = pendingTurns[requestId];
        if (!pt.exists) revert UnknownRequest();
        if (block.timestamp <= pt.deadline) revert NotYetExpired();
        delete pendingTurns[requestId];
        duels[pt.duelId].completedCallbacks += 1;
        emit FighterMoveFailed(pt.duelId, pt.fighterId, "timed out");
    }

    // TEST ONLY — remove before mainnet (not removing in Phase 3 since v1 is testnet-only).
    function testRequestFighterMove(uint256 duelId, uint8 fighterId) external onlyOwner returns (uint256) {
        return _requestFighterMove(duelId, fighterId);
    }

    function debugPlaceOrder(
        uint256 duelId,
        uint8 fighterId,
        address pool,
        bool isBid,
        uint256 price,
        uint256 quantity,
        uint8 orderType,
        uint64 expireOffsetSec
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        return _placeOrderForFighter(duelId, fighterId, pool, isBid, price, quantity, orderType, expireOffsetSec);
    }

    function cancelOrder(address pool, uint128 orderId) external onlyOwner {
        if (pool != POOL_WETH && pool != POOL_WBTC && pool != POOL_SOMI) revert InvalidPool(pool);
        ISpotPool(pool).cancelOrder(orderId);
    }

    function startDuel(
        uint8 fighterA,
        uint8 fighterB,
        address pool,
        uint256 initialUsdsoPerFighter
    ) external onlyOwner returns (uint256 duelId) {
        if (activeDuelId != 0 && duels[activeDuelId].status != DuelStatus.Resolved) revert DuelAlreadyActive();
        uint8 count = registry.FIGHTER_COUNT();
        if (fighterA == fighterB || fighterA >= count || fighterB >= count) revert InvalidFighterPair();
        if (pool != POOL_WETH && pool != POOL_WBTC && pool != POOL_SOMI) revert InvalidPoolForDuel();
        if (initialUsdsoPerFighter == 0) revert ZeroAmount();

        duelId = nextDuelId++;
        duels[duelId] = Duel({
            fighterA: fighterA,
            fighterB: fighterB,
            startBlock: block.number,
            lastTurnBlock: block.number,
            completedCallbacks: 0,
            status: DuelStatus.Active,
            pool: pool,
            initialUsdsoPerFighter: initialUsdsoPerFighter
        });
        activeDuelId = duelId;
        fighterBalances[pool][duelId][fighterA].quoteTokenAmount = initialUsdsoPerFighter;
        fighterBalances[pool][duelId][fighterB].quoteTokenAmount = initialUsdsoPerFighter;
        emit DuelStarted(duelId, fighterA, fighterB, pool, block.number);
    }

    function turn() external {
        _runTurn();
    }

    function finalizeDuel(uint256 duelId) external {
        Duel storage duel = duels[duelId];
        if (duel.status != DuelStatus.Active) revert DuelNotActive();
        if (duel.completedCallbacks < TURNS_PER_DUEL * 2) revert DuelNotReadyToFinalize();

        duel.status = DuelStatus.Finalizing;

        address pool = duel.pool;
        uint256 markPrice = ISpotPool(pool).getMarkPrice();

        PoolBalance memory balA = fighterBalances[pool][duelId][duel.fighterA];
        PoolBalance memory balB = fighterBalances[pool][duelId][duel.fighterB];

        uint256 valueA = balA.quoteTokenAmount + (balA.baseTokenAmount * markPrice / 1e18);
        uint256 valueB = balB.quoteTokenAmount + (balB.baseTokenAmount * markPrice / 1e18);

        uint8 winner = valueA >= valueB ? duel.fighterA : duel.fighterB;
        duel.status = DuelStatus.Resolved;
        activeDuelId = 0;
        emit DuelResolved(duelId, winner, valueA, valueB);
    }

    function fundPools(uint256 usdsoPerPool) external onlyOwner {
        if (usdsoPerPool == 0) revert ZeroAmount();

        address[3] memory pools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        for (uint256 i = 0; i < 3; i++) {
            address pool = pools[i];

            bool ok = IERC20Minimal(USDSO).transferFrom(msg.sender, address(this), usdsoPerPool);
            if (!ok) revert TransferFailed();

            ok = IERC20Minimal(USDSO).approve(pool, usdsoPerPool);
            if (!ok) revert ApproveFailed();

            ISpotPool(pool).deposit(USDSO, usdsoPerPool);
        }

        emit PoolsFunded(usdsoPerPool, usdsoPerPool * 3);
    }
}
