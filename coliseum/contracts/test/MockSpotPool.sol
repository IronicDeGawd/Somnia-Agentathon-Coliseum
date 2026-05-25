// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MockSpotPool {
    // user => token => balance
    mapping(address => mapping(address => uint256)) private _balances;

    function deposit(address token, uint256 amount) external {
        require(
            IERC20Pull(token).transferFrom(msg.sender, address(this), amount),
            "MockSpotPool: transferFrom failed"
        );
        _balances[msg.sender][token] += amount;
    }

    function depositNative() external payable {
        revert("not implemented");
    }

    function withdraw(address token, uint256 amount) external {
        require(_balances[msg.sender][token] >= amount, "MockSpotPool: insufficient");
        _balances[msg.sender][token] -= amount;
    }

    function getWithdrawableBalance(address user, address token) external view returns (uint256) {
        return _balances[user][token];
    }

    function placeOrder(
        bool,
        uint64,
        uint256,
        uint256,
        uint64,
        uint8,
        uint8,
        address,
        uint96
    ) external pure returns (bool, uint128) {
        revert("not implemented");
    }

    function cancelOrder(uint128) external pure {
        revert("not implemented");
    }

    function getPoolParams() external pure returns (uint256, uint256, uint256) {
        revert("not implemented");
    }
}
