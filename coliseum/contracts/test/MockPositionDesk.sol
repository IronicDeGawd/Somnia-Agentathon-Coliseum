// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISpotPool.sol";

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice A token address that has code and answers NOTHING.
///
///         This is the real shape of the position token a live prediction desk
///         advertises: an uninitialised proxy. It delegates to an implementation
///         that was never set, so every call returns empty data, which the caller
///         decodes as a failure. Any mock that answers a balance question is a
///         mock that cannot reproduce the fault this file exists for — the event
///         tests used one that did, which is why a market with no exit shipped.
contract MuteOutcomeToken {
    /// It must REVERT, not return empty.
    ///
    /// Solidity's try/catch cannot catch a call that SUCCEEDS but returns
    /// undecodable data — that unwinds the whole transaction, so a mock returning
    /// empty here breaks the prompt instead of exercising the fallback, which is
    /// not what the live token does. Confirmed against the real one: it answers
    /// with a revert.
    fallback() external { revert("no implementation"); }
}

/// @notice A venue that keeps the position on its own books, the way a prediction
///         desk does, and reports it through `yesBalance18` rather than through a
///         token balance.
contract MockPositionDesk {
    MuteOutcomeToken public immutable outcomeToken;

    address private _quoteToken;
    uint256 private _tickSize    = 1e15;
    uint256 private _minQuantity = 0;
    uint256 private _lotSize     = 1;

    uint256 private _yes18;
    bool    private _muteVenueToo;

    mapping(address => mapping(address => uint256)) private _balances;
    mapping(bool => OrderBookLevel[]) private _bookLevels;

    uint128 public nextOrderId;
    uint256 public ordersPlaced;
    bool    public lastOrderWasBid;
    uint256 public lastOrderQuantity;

    constructor(address quoteToken) {
        outcomeToken = new MuteOutcomeToken();
        _quoteToken  = quoteToken;
    }

    /// @notice What this desk can currently hand over, in Arena's 18 decimals.
    ///         Named to match the live `EventDesk`, which is what Arena asks.
    function yesBalance18() external view returns (uint256) {
        require(!_muteVenueToo, "desk cannot answer either");
        return _yes18;
    }

    function setYesBalance18(uint256 v) external { _yes18 = v; }

    /// @notice Make the VENUE refuse the question too. A venue that can answer
    ///         neither must still be refused, or the fix would be handing out
    ///         exits nothing can honour.
    function setMuteVenue(bool m) external { _muteVenueToo = m; }

    function setPoolParams(uint256 tickSize, uint256 minQuantity, uint256 lotSize) external {
        _tickSize    = tickSize;
        _minQuantity = minQuantity;
        _lotSize     = lotSize;
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
        return (address(outcomeToken), _quoteToken, 0, 0, _tickSize, _minQuantity, _lotSize);
    }

    function setBookLevel(bool isBid, uint256 price, uint256 quantity) external {
        delete _bookLevels[isBid];
        _bookLevels[isBid].push(OrderBookLevel({ price: price, quantity: quantity }));
    }

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory) {
        uint256 n = _bookLevels[isBid].length;
        if (n > numLevels) n = numLevels;
        OrderBookLevel[] memory out = new OrderBookLevel[](n);
        for (uint256 i = 0; i < n; i++) out[i] = _bookLevels[isBid][i];
        return out;
    }

    /// @notice Credit a vault balance nobody deposited — a desk's cash comes from
    ///         its own treasury, not from Arena.
    function creditVault(address user, address token, uint256 amount) external {
        _balances[user][token] += amount;
    }

    function getWithdrawableBalance(address user, address token) external view returns (uint256) {
        return _balances[user][token];
    }

    function deposit(address token, uint256 amount) external {
        require(IERC20Pull(token).transferFrom(msg.sender, address(this), amount), "pull failed");
        _balances[msg.sender][token] += amount;
    }

    function depositNative() external payable { revert("not implemented"); }

    function withdraw(address token, uint256 amount) external {
        require(_balances[msg.sender][token] >= amount, "insufficient");
        _balances[msg.sender][token] -= amount;
        require(IERC20Pull(token).transfer(msg.sender, amount), "transfer failed");
    }

    /// @notice A back moves the desk's position up, a drop moves it down. No
    ///         token ever changes hands with Arena, which is the whole point:
    ///         the position lives here.
    function placeOrder(
        bool isBid,
        uint64,
        uint256,
        uint256 quantity,
        uint64,
        uint8,
        uint8,
        address,
        uint96
    ) external payable returns (bool, uint128) {
        uint128 orderId = nextOrderId++;
        ordersPlaced++;
        lastOrderWasBid   = isBid;
        lastOrderQuantity = quantity;
        if (isBid) _yes18 += quantity;
        else       _yes18 = _yes18 > quantity ? _yes18 - quantity : 0;
        return (true, orderId);
    }

    function cancelOrder(uint128) external { }
    function getMarkPrice() external view returns (uint256) { return 0; }
}
