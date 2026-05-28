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
    event VaultWithdrawn(address indexed pool, address indexed token, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event Resubscribed(uint256 indexed newSubscriptionId);
    event NativeWithdrawn(address indexed to, uint256 amount);

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
        uint8[2]    lastAction;  // last FighterAction taken per fighter (0=Hold initially)
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

    /// @notice Per-pool ABI metadata cached at construction (decimals from constructor args,
    ///         minQuantity/lotSize/tickSize fetched via getPoolParams). Used by
    ///         _executeFighterAction to size FOK orders correctly.
    struct PoolMeta {
        uint8 baseDecimals;
        uint256 minQuantity;
        uint256 lotSize;
        uint256 tickSize;
    }
    mapping(address => PoolMeta) public poolMeta;

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
        uint256 _turnIntervalBlocks,
        uint8[3] memory _baseDecimals  // [WETH, WBTC, SOMI] — passed in to avoid querying baseToken.decimals() in constructor
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

        // Cache pool metadata. Wrapped in try/catch so local hardhat (no real pool) still deploys.
        _cachePoolMeta(_poolWeth, _baseDecimals[0]);
        _cachePoolMeta(_poolWbtc, _baseDecimals[1]);
        _cachePoolMeta(_poolSomi, _baseDecimals[2]);

        subscriptionId = _subscribeReactivity();
    }

    function _cachePoolMeta(address pool, uint8 baseDecimals) internal {
        try ISpotPool(pool).getPoolParams() returns (
            address, address, uint256, uint256,
            uint256 tickSize, uint256 minQty, uint256 lotSize
        ) {
            poolMeta[pool] = PoolMeta({
                baseDecimals: baseDecimals,
                minQuantity: minQty,
                lotSize: lotSize,
                tickSize: tickSize
            });
        } catch {
            // Fallback for local hardhat — let the mock or future setter populate it.
            poolMeta[pool] = PoolMeta({
                baseDecimals: baseDecimals,
                minQuantity: 0,
                lotSize: 1,
                tickSize: 1
            });
        }
    }

    receive() external payable {}

    function _subscribeReactivity() internal returns (uint256 newId) {
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
            newId = abi.decode(ret, (uint256));
        } else {
            newId = 0;
            emit SubscriptionSkipped("precompile unavailable");
        }
    }

    /// @notice Re-subscribe to BlockTick after the precompile auto-removed the prior subscription
    ///         (happens when this contract's balance drops below SUBSCRIPTION_OWNER_MINIMUM_BALANCE).
    ///         Caller must ensure this contract holds >= 32 STT before calling — top up via `receive()`.
    function resubscribe() external onlyOwner returns (uint256 newId) {
        if (address(this).balance < REACTIVITY_FUND_MIN) revert ReactivityUnderfunded();
        newId = _subscribeReactivity();
        subscriptionId = newId;
        emit Resubscribed(newId);
    }

    /// @notice Sweep native STT out of this contract back to the owner. Pair with topup flows
    ///         when retiring an Arena instance.
    function withdrawNative(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit NativeWithdrawn(to, amount);
    }

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

    function _uint256ToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory buf = new bytes(78);
        uint256 len = 0;
        uint256 tmp = v;
        while (tmp > 0) { buf[len++] = bytes1(uint8(48 + (tmp % 10))); tmp /= 10; }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = buf[len - 1 - i];
        return string(out);
    }

    function _actionName(uint8 a) internal pure returns (string memory) {
        if (a == 1) return "BuyWBTC";
        if (a == 2) return "SellWBTC";
        if (a == 3) return "BuyWETH";
        if (a == 4) return "SellWETH";
        if (a == 5) return "BuySOMI";
        if (a == 6) return "SellSOMI";
        return "Hold";
    }

    function _vaultLine(string memory label, address pool, uint256 duelId, uint8 fighterId) internal view returns (string memory) {
        PoolBalance memory bal = fighterBalances[pool][duelId][fighterId];
        PoolMeta memory meta = poolMeta[pool];
        uint256 baseUnit = 10 ** meta.baseDecimals;
        // quote (USDso 18-dec) → display as integer USDso
        uint256 usdso = bal.quoteTokenAmount / 1e18;
        // base units → display with up to 4 decimal places
        uint256 baseWhole = bal.baseTokenAmount / baseUnit;
        uint256 baseFrac = (bal.baseTokenAmount % baseUnit) * 10000 / baseUnit;
        string memory canTrade = (bal.quoteTokenAmount >= (meta.minQuantity * _midMarkPrice(pool)) / baseUnit) ? "" : " [skip-no-funds]";
        return string.concat(
            label, ": ", _uint256ToString(usdso), " USDso / ",
            _uint256ToString(baseWhole), ".", _uint256ToString(baseFrac), " base",
            canTrade
        );
    }

    function _buildMarketSummary(uint256 duelId, uint8 fighterId) internal view returns (string memory) {
        Duel storage duel = duels[duelId];
        uint16 turnNum = duel.completedCallbacks / 2 + 1;
        string memory lastAct = _actionName(duel.lastAction[fighterId]);
        return string.concat(
            "duel ", _uint256ToString(duelId),
            " turn ", _uint256ToString(turnNum), "/", _uint256ToString(TURNS_PER_DUEL),
            ". last action: ", lastAct,
            ". ", _vaultLine("WETH", POOL_WETH, duelId, fighterId),
            ". ", _vaultLine("WBTC", POOL_WBTC, duelId, fighterId),
            ". ", _vaultLine("SOMI", POOL_SOMI, duelId, fighterId),
            ". Pick 0=Hold 1=BuyWBTC 2=SellWBTC 3=BuyWETH 4=SellWETH 5=BuySOMI 6=SellSOMI."
        );
    }

    function _requestFighterMove(uint256 duelId, uint8 fighterId) internal returns (uint256 requestId) {
        IFighterRegistry.Fighter memory f = registry.getFighter(fighterId);
        string memory marketSummary = _buildMarketSummary(duelId, fighterId);
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

        // Pool ABI metadata (decimals, minQuantity, lotSize, tickSize) — cached at construction.
        PoolMeta memory meta = poolMeta[pool];
        uint256 baseUnit = 10 ** uint256(meta.baseDecimals);

        PoolBalance storage bal = fighterBalances[pool][duelId][fighterId];
        uint256 desired;
        if (isBid) {
            if (bal.quoteTokenAmount == 0) {
                emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "no quote balance");
                return (false, 0);
            }
            // Size each bid at exactly minQuantity (smallest valid order) so the vault
            // burns slowly across turns rather than in one large fill. Check the real
            // vault can cover the cost before placing.
            uint256 minCost = (meta.minQuantity * price) / baseUnit;
            uint256 vaultQuote = ISpotPool(pool).getWithdrawableBalance(address(this), USDSO);
            if (vaultQuote < minCost) {
                emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "vault below min cost");
                return (false, 0);
            }
            desired = meta.minQuantity;
        } else {
            if (bal.baseTokenAmount == 0) {
                emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "no base balance");
                return (false, 0);
            }
            desired = bal.baseTokenAmount;
        }

        uint256 quantity = desired < available ? desired : available;
        // Align DOWN to lotSize (avoids "not a multiple of lot" rejects)
        if (meta.lotSize > 0) {
            quantity = (quantity / meta.lotSize) * meta.lotSize;
        }
        if (quantity == 0) {
            emit OrderRejected(pool, fighterId, duelId, isBid, price, 0, 1, "zero quantity");
            return (false, 0);
        }
        // Enforce pool minimum order size
        if (quantity < meta.minQuantity) {
            emit OrderRejected(pool, fighterId, duelId, isBid, price, quantity, 1, "below minQuantity");
            return (false, 0);
        }
        // Align price to tickSize (round UP for bid so we still cross the ask; DOWN for ask)
        if (meta.tickSize > 0) {
            price = isBid
                ? ((price + meta.tickSize - 1) / meta.tickSize) * meta.tickSize
                : (price / meta.tickSize) * meta.tickSize;
        }

        // orderType 1 = FOK
        (ok, orderId) = _placeOrderForFighter(duelId, fighterId, pool, isBid, price, quantity, 1, 3600);
        if (ok) {
            // quote = price * quantity / 10^baseDecimals (price is in 18-decimal quote per base unit)
            uint256 quoteCost = (price * quantity) / baseUnit;
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
        duels[pt.duelId].lastAction[pt.fighterId] = uint8(action);
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
            initialUsdsoPerFighter: initialUsdsoPerFighter,
            lastAction: [uint8(0), uint8(0)]
        });
        activeDuelId = duelId;

        // Seed virtual quote balance on ALL three pools so the LLM can pick any of the 6 actions.
        // Per-pool budget = initialUsdsoPerFighter so a fighter can spend up to that on each market.
        address[3] memory allPools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        for (uint256 i = 0; i < 3; i++) {
            fighterBalances[allPools[i]][duelId][fighterA].quoteTokenAmount = initialUsdsoPerFighter;
            fighterBalances[allPools[i]][duelId][fighterB].quoteTokenAmount = initialUsdsoPerFighter;
        }
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

        // Sum each fighter's USDso-equivalent across ALL pools they may have traded on.
        // Mark price for each pool = midpoint of best bid and best ask via getBookLevels.
        address[3] memory allPools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        uint256 valueA = 0;
        uint256 valueB = 0;
        for (uint256 i = 0; i < 3; i++) {
            address pool = allPools[i];
            uint256 markPrice = _midMarkPrice(pool);
            uint256 baseUnit = 10 ** uint256(poolMeta[pool].baseDecimals);
            PoolBalance memory balA = fighterBalances[pool][duelId][duel.fighterA];
            PoolBalance memory balB = fighterBalances[pool][duelId][duel.fighterB];
            valueA += balA.quoteTokenAmount + (balA.baseTokenAmount * markPrice / baseUnit);
            valueB += balB.quoteTokenAmount + (balB.baseTokenAmount * markPrice / baseUnit);
        }

        uint8 winner = valueA >= valueB ? duel.fighterA : duel.fighterB;
        duel.status = DuelStatus.Resolved;
        activeDuelId = 0;
        emit DuelResolved(duelId, winner, valueA, valueB);
    }

    /// @dev Returns (bestBid + bestAsk) / 2 as the mark price. Falls back to whichever
    ///      side is populated, or 0 if both sides are empty. Used by finalizeDuel.
    function _midMarkPrice(address pool) internal view returns (uint256) {
        uint256 bid = 0;
        uint256 ask = 0;
        try ISpotPool(pool).getBookLevels(true, 1) returns (OrderBookLevel[] memory bids) {
            if (bids.length > 0) bid = bids[0].price;
        } catch {}
        try ISpotPool(pool).getBookLevels(false, 1) returns (OrderBookLevel[] memory asks) {
            if (asks.length > 0) ask = asks[0].price;
        } catch {}
        if (bid > 0 && ask > 0) return (bid + ask) / 2;
        if (bid > 0) return bid;
        if (ask > 0) return ask;
        return 0;
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

    // Pull seeded vault funds out of a pool back into Arena's own ERC20 balance.
    // Pair with sweepToken to send the recovered tokens to the owner.
    function withdrawFromPool(address pool, address token, uint256 amount) external onlyOwner {
        if (pool != POOL_WETH && pool != POOL_WBTC && pool != POOL_SOMI) revert InvalidPool(pool);
        if (amount == 0) revert ZeroAmount();
        ISpotPool(pool).withdraw(token, amount);
        emit VaultWithdrawn(pool, token, amount);
    }

    function sweepToken(address token, address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        bool ok = IERC20Minimal(token).transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit TokenSwept(token, to, amount);
    }
}
