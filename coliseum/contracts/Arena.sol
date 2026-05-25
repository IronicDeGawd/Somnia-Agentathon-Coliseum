// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IFighterRegistry.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/IERC20Minimal.sol";

contract Arena {
    error NotOwner();
    error ZeroAmount();
    error TransferFailed();
    error ApproveFailed();
    error InvalidPool(address pool);
    error InvalidExpiry();
    error BadOrderType();

    uint64 public constant MAX_EXPIRE_OFFSET_SEC = 7 days;

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
        address _poolSomi
    ) {
        registry = IFighterRegistry(_registry);
        USDSO = _usdso;
        POOL_WETH = _poolWeth;
        POOL_WBTC = _poolWbtc;
        POOL_SOMI = _poolSomi;
        owner = msg.sender;
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
