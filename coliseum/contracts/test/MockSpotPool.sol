// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISpotPool.sol";

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
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
    bool private _nextShouldRevert;
    uint256 public markPrice;

    function setNextOrderShouldReject(bool reject) external {
        _nextShouldReject = reject;
    }

    /// @notice Single-shot, mirroring `_nextShouldReject`, but models a venue
    ///         whose low-level call REVERTS rather than gracefully returning
    ///         `(false, 0)` — e.g. an out-of-gas revert deep in its own matching
    ///         logic, as opposed to a deliberate refusal.
    function setNextOrderShouldRevert(bool doRevert) external {
        _nextShouldRevert = doRevert;
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

    /// @notice Credit a vault balance without anyone depositing.
    ///
    ///         Models an EventDesk, which reports the balance its own treasury
    ///         funded rather than one Arena paid in — so Arena sees quote
    ///         liquidity it never deposited. Test-only.
    function creditVault(address user, address token, uint256 amount) external {
        _balances[user][token] += amount;
    }

    function withdraw(address token, uint256 amount) external {
        require(_balances[msg.sender][token] >= amount, "MockSpotPool: insufficient");
        _balances[msg.sender][token] -= amount;
        require(
            IERC20Pull(token).transfer(msg.sender, amount),
            "MockSpotPool: transfer failed"
        );
    }

    function getWithdrawableBalance(address user, address token) external view returns (uint256) {
        return _balances[user][token];
    }

    /// @notice Test-only settlement config for the NEXT `placeOrder` call: a bid
    ///         pays quote and receives base, an ask pays base (or, when the base
    ///         is native, sends value with the call instead) and receives quote.
    ///         Single-shot, mirroring `_nextShouldReject`, because this mock has
    ///         no real matching engine to derive a fill from.
    uint256 private _fillBase;
    uint256 private _fillQuote;

    function setNextFill(uint256 baseAmount, uint256 quoteAmount) external {
        _fillBase = baseAmount;
        _fillQuote = quoteAmount;
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
    ) external payable returns (bool, uint128) {
        if (_nextShouldRevert) {
            _nextShouldRevert = false;
            revert("MockSpotPool: forced revert");
        }

        if (_nextShouldReject) {
            _nextShouldReject = false;
            return (false, 0);
        }

        uint128 orderId = nextOrderId;
        orders.push(Order({ isBid: isBid, price: price, quantity: quantity, orderType: orderType, cancelled: false }));
        nextOrderId++;

        uint256 fillBase = _fillBase;
        uint256 fillQuote = _fillQuote;
        _fillBase = 0;
        _fillQuote = 0;
        if (isBid) {
            if (fillQuote > 0) {
                require(IERC20Pull(_quoteToken).transferFrom(msg.sender, address(this), fillQuote), "MockSpotPool: quote pull failed");
            }
            if (fillBase > 0) {
                require(IERC20Pull(_baseToken).transfer(msg.sender, fillBase), "MockSpotPool: base pay failed");
            }
        } else {
            // A native base arrives as `value` on this call, so there is nothing
            // to pull for it — only a non-native base is taken via transferFrom.
            if (fillBase > 0 && _baseToken != address(0)) {
                require(IERC20Pull(_baseToken).transferFrom(msg.sender, address(this), fillBase), "MockSpotPool: base pull failed");
            }
            if (fillQuote > 0) {
                require(IERC20Pull(_quoteToken).transfer(msg.sender, fillQuote), "MockSpotPool: quote pay failed");
            }
        }

        return (true, orderId);
    }

    function cancelOrder(uint128 orderId) external {
        require(orderId < nextOrderId, "MockSpotPool: unknown orderId");
        orders[orderId].cancelled = true;
    }

    // Stored params so tests can tune per-pool minQuantity/lotSize/tickSize behavior.
    address private _baseToken;
    address private _quoteToken;
    uint256 private _tickSize = 1e15;
    uint256 private _minQuantity = 0;          // default 0 so existing tests' tiny orders still go through
    uint256 private _lotSize = 1;              // default 1 to disable lot alignment

    function setPoolParams(address baseToken, address quoteToken, uint256 tickSize, uint256 minQuantity, uint256 lotSize) external {
        _baseToken = baseToken;
        _quoteToken = quoteToken;
        _tickSize = tickSize;
        _minQuantity = minQuantity;
        _lotSize = lotSize;
    }

    function getPoolParams() external view returns (
        address baseToken,
        address quoteToken,
        uint256 makerFeeBpsTimes1k,
        uint256 takerFeeBpsTimes1k,
        uint256 tickSize,
        uint256 minQuantity,
        uint256 lotSize
    ) {
        return (_baseToken, _quoteToken, 0, 0, _tickSize, _minQuantity, _lotSize);
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
