// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISpotPool.sol";

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MockSpotPool {
    struct Order {
        bool isBid;
        uint256 price;
        uint256 quantity;
        uint8 orderType;
        bool cancelled;
    }

    // user => token => balance
    mapping(address => mapping(address => uint256)) private _balances;

    Order[] public orders;
    uint128 public nextOrderId;

    bool private _nextShouldReject;
    uint256 public markPrice;

    function setNextOrderShouldReject(bool reject) external {
        _nextShouldReject = reject;
    }

    function setMarkPrice(uint256 price) external {
        markPrice = price;
    }

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
        bool isBid,
        uint64,
        uint256 price,
        uint256 quantity,
        uint64,
        uint8 orderType,
        uint8,
        address,
        uint96
    ) external returns (bool, uint128) {
        if (_nextShouldReject) {
            _nextShouldReject = false;
            return (false, 0);
        }

        uint128 orderId = nextOrderId;
        orders.push(Order({ isBid: isBid, price: price, quantity: quantity, orderType: orderType, cancelled: false }));
        nextOrderId++;

        return (true, orderId);
    }

    function cancelOrder(uint128 orderId) external {
        require(orderId < nextOrderId, "MockSpotPool: unknown orderId");
        orders[orderId].cancelled = true;
    }

    function getPoolParams() external pure returns (uint256, uint256, uint256) {
        return (1e15, 1e15, 1e15);
    }

    function getMarkPrice() external view returns (uint256) {
        return markPrice;
    }

    function getOrdersCount() external view returns (uint256) {
        return orders.length;
    }

    // --- Book level mocking ---
    // _bookLevels[isBid] = list of levels; index 0 = best (highest bid / lowest ask)
    mapping(bool => OrderBookLevel[]) private _bookLevels;

    function setBookLevel(bool isBid, uint256 price, uint256 quantity) external {
        delete _bookLevels[isBid];
        _bookLevels[isBid].push(OrderBookLevel({ price: price, quantity: quantity }));
    }

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory) {
        uint256 n = _bookLevels[isBid].length;
        if (n > numLevels) n = numLevels;
        OrderBookLevel[] memory out = new OrderBookLevel[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _bookLevels[isBid][i];
        }
        return out;
    }
}
