// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISpotPool.sol";

/// @title  MockPerpPool
/// @notice A stand-in for one dreamDEX perpetual market.
///
///         Test-only, and again deliberately faithful about the handful of behaviours
///         a plausible-looking stub would paper over:
///
///          - A REJECTED ORDER RETURNS `(false, 0)`. It does NOT revert. The upstream
///            interface documentation says otherwise and the deployed bytecode
///            disagrees with it — measured 2026-08-19, for both fill-or-kill and
///            immediate-or-cancel. Code that only handled a revert would look correct
///            here and lose turns in production.
///
///          - FILLS ARE PARTIAL AND CONSUME THE BOOK. An immediate-or-cancel order
///            takes what is there, at each level's own price, and discards the rest.
///            That is what makes crossing several levels deep to flatten a position
///            safe rather than expensive, so the flatten path can only be tested
///            against a book that actually empties.
///
///          - THE MARGIN FACTOR IS SETTABLE AND SEPARATE FROM CONFIG. `getEffectiveIMF`
///            scales with open interest on the real market — Bitcoin was measured at
///            3.7x its configured factor — so the tier ladder has to be testable
///            against a factor that moves.
///
///          - IT CAN GO DARK. `setPriceable(false)` models a stale oracle, which is
///            the one thing that can take a fighter's score away at exactly the wrong
///            moment.
contract MockPerpPool {

    address public immutable bank;

    uint256 private _oneBase;
    uint256 private _tickSize;
    uint256 private _minQuantity;
    uint256 private _lotSize;

    uint256 private _mark;
    uint256 private _imf;
    bool    private _priceable = true;
    bool    private _restricted;

    /// @notice Reproduces the live oracle fault: `placeOrder` never returns, it runs
    ///         until whatever gas the caller forwarded is gone. A bare `try/catch`
    ///         around a call into this swallows the resulting out-of-gas as a clean
    ///         `(false, 0)` — this flag is what makes that swallowing testable.
    bool    private _burnGas;
    /// @notice A plain revert, as distinct from the silent `(false, 0)` refusal shape
    ///         this mock otherwise uses — so a rescue path can be checked against
    ///         both failure shapes the live pool is known to produce.
    bool    private _revertOnPlace;

    uint128 public nextOrderId = 1;

    /// @dev isBid => levels, index 0 = best (highest bid / lowest ask).
    mapping(bool => OrderBookLevel[]) private _book;

    event Filled(address indexed account, bool isBid, uint256 avgPrice, uint256 quantity, uint64 userData);

    constructor(
        address bank_,
        uint256 oneBase_,
        uint256 tickSize_,
        uint256 minQuantity_,
        uint256 lotSize_,
        uint256 mark_,
        uint256 imf_
    ) {
        bank         = bank_;
        _oneBase     = oneBase_;
        _tickSize    = tickSize_;
        _minQuantity = minQuantity_;
        _lotSize     = lotSize_;
        _mark        = mark_;
        _imf         = imf_;
    }

    // ─── Test controls ────────────────────────────────────────────────────────

    function setMark(uint256 mark_) external { _mark = mark_; }
    function setEffectiveIMF(uint256 imf_) external { _imf = imf_; }
    function setPriceable(bool ok) external { _priceable = ok; }
    function setRestricted(bool r) external { _restricted = r; }
    function setBurnGas(bool b) external { _burnGas = b; }
    function setRevertOnPlace(bool r) external { _revertOnPlace = r; }

    function clearBook(bool isBid) external { delete _book[isBid]; }

    /// @notice Append a level BELOW the ones already there, so a book is built best
    ///         level first and the flatten path has real depth to sweep.
    function pushBookLevel(bool isBid, uint256 price, uint256 quantity) external {
        _book[isBid].push(OrderBookLevel({ price: price, quantity: quantity }));
    }

    /// @notice Replace the whole side with a single level. The common case.
    function setBookLevel(bool isBid, uint256 price, uint256 quantity) external {
        delete _book[isBid];
        _book[isBid].push(OrderBookLevel({ price: price, quantity: quantity }));
    }

    // ─── The perp-market surface ──────────────────────────────────────────────

    function getOneBase() external view returns (uint256) { return _oneBase; }

    function getOrderBookParameters() external view returns (uint256, uint256, uint256) {
        return (_tickSize, _minQuantity, _lotSize);
    }

    function tryGetMarkPrice() external view returns (bool ok, uint256 price) {
        if (!_priceable || _mark == 0) return (false, 0);
        return (true, _mark);
    }

    function getMarkPrice() external view returns (uint256) {
        require(_priceable && _mark > 0, "OraclePriceStale");
        return _mark;
    }

    function getEffectiveIMF() external view returns (uint256) {
        // Hard-reverts on an unreadable index, exactly as the real one does when
        // dynamic margin is enabled. `isPriceable` is what makes it safe to call.
        require(_priceable, "OraclePriceStale");
        return _imf;
    }

    function isPriceable() external view returns (bool) { return _priceable && _mark > 0; }

    function isRestricted() external view returns (bool) { return _restricted; }

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory) {
        uint256 n = _book[isBid].length;
        if (n > numLevels) n = numLevels;
        OrderBookLevel[] memory out = new OrderBookLevel[](n);
        for (uint256 i = 0; i < n; i++) out[i] = _book[isBid][i];
        return out;
    }

    /// @notice Take liquidity from the opposite side, up to `quantity`, at each
    ///         level's own price, and settle the average into the bank.
    /// @return success false when nothing filled — WITHOUT reverting, which is the
    ///         behaviour the deployed pool actually has.
    function placeOrder(
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  /* expireTimestampNs */,
        uint8   /* orderType */,
        uint8   /* selfMatchingOption */,
        address /* builder */,
        uint96  /* builderFeeBpsTimes1k */
    ) external payable returns (bool success, uint128 id) {
        if (_revertOnPlace) revert("MockPerpPool: forced revert");
        if (_burnGas) {
            // No gasleft() check on purpose: a loop that stops itself near empty
            // would just return normally, which is not the failure being modelled.
            // This one only ever ends by exhausting whatever gas was forwarded.
            uint256 i;
            while (true) { i++; }
        }
        if (_restricted) return (false, 0);
        if (!_priceable) return (false, 0);
        if (quantity == 0 || quantity < _minQuantity) return (false, 0);

        OrderBookLevel[] storage side = _book[!isBid];
        uint256 remaining = quantity;
        uint256 filled;
        uint256 notional;

        for (uint256 i = 0; i < side.length && remaining > 0; i++) {
            // A buy crosses a level at or below its limit; a sell at or above.
            if (isBid ? side[i].price > price : side[i].price < price) continue;
            uint256 take = side[i].quantity < remaining ? side[i].quantity : remaining;
            if (take == 0) continue;
            side[i].quantity -= take;
            remaining -= take;
            filled   += take;
            notional += take * side[i].price;
        }

        if (filled == 0) return (false, 0);

        // Settling can revert — that is the auto-pull failing against a zero
        // allowance, and it must reach the caller so the order counts as refused.
        IMockBank(bank).applyFill(msg.sender, address(this), isBid, notional / filled, filled);

        id = nextOrderId++;
        emit Filled(msg.sender, isBid, notional / filled, filled, userData);
        return (true, id);
    }
}

interface IMockBank {
    function applyFill(address account, address market, bool isBid, uint256 price, uint256 quantity) external;
}
