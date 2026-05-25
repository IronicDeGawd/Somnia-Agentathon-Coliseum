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

    event PoolsFunded(uint256 usdsoPerPool, uint256 totalDeposited);

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
