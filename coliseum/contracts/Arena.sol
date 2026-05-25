// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IFighterRegistry.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/ISomniaAgents.sol";

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
        address _platform
    ) {
        registry = IFighterRegistry(_registry);
        USDSO = _usdso;
        POOL_WETH = _poolWeth;
        POOL_WBTC = _poolWbtc;
        POOL_SOMI = _poolSomi;
        PLATFORM_ADDR = _platform;
        owner = msg.sender;
    }

    receive() external payable {}

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

        (ok, orderId) = ISpotPool(pool).placeOrder(
            isBid,
            0,
            price,
            quantity,
            expireTimestampNs,
            orderType,
            0,
            address(0),
            0
        );

        if (!ok) {
            emit OrderRejected(pool, fighterId, duelId, isBid, price, quantity, orderType, "silent reject");
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

        // IOC (orderType=2) — no PostOnly accounting needed for Phase 3
        return _placeOrderForFighter(duelId, fighterId, pool, isBid, 1e18, 1e15, 2, 3600);
    }

    function handleFighterResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory  /* details */
    ) external {
        if (msg.sender != PLATFORM_ADDR) revert OnlyPlatform();
        PendingTurn memory turn = pendingTurns[requestId];
        if (!turn.exists) {
            emit FighterMoveFailed(0, 0, "unknown request");
            return;
        }
        delete pendingTurns[requestId];

        if (status != ResponseStatus.Success || responses.length == 0) {
            emit FighterMoveFailed(turn.duelId, turn.fighterId, "no consensus");
            return;
        }

        if (responses[0].result.length != 32) {
            emit FighterMoveFailed(turn.duelId, turn.fighterId, "bad encoding");
            return;
        }
        int256 raw = abi.decode(responses[0].result, (int256));
        if (raw < 0 || raw > 6) {
            emit FighterMoveFailed(turn.duelId, turn.fighterId, "out of range");
            return;
        }
        FighterAction action = FighterAction(uint8(uint256(raw)));
        (bool ok, uint128 orderId) = _executeFighterAction(turn.duelId, turn.fighterId, action);
        if (!ok) {
            emit FighterMoveFailed(turn.duelId, turn.fighterId, "exec failed");
            return;
        }
        emit FighterMove(turn.duelId, turn.fighterId, action, orderId);
    }

    function expireTurn(uint256 requestId) external onlyOwner {
        PendingTurn memory turn = pendingTurns[requestId];
        if (!turn.exists) revert UnknownRequest();
        if (block.timestamp <= turn.deadline) revert NotYetExpired();
        delete pendingTurns[requestId];
        emit FighterMoveFailed(turn.duelId, turn.fighterId, "timed out");
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
