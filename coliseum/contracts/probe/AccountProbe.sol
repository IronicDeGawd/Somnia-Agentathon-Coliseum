// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20Minimal.sol";

/// @title AccountProbe — the smallest thing that could be the unified container.
///
/// Written to answer three questions that the whole one-engine idea rests on, and
/// which no amount of reading the code can settle:
///
///   1. Can a CONTRACT (not a wallet) buy on a spot venue and have the fill land in
///      its own balance? The arena does this today, but the arena also holds four
///      other kinds of money, so it cannot prove the isolated case.
///   2. Can the same contract then sell what it bought, out of its own balance?
///   3. Can it sell the market whose asset is the chain's own coin — the trade the
///      game currently cannot make at all — by sending value with the order?
///
/// Deliberately dumb: one owner, no bookkeeping, no lease, no accounting. If a
/// container this simple can do all three, the engine is buildable and the rest is
/// plumbing. If it cannot, the design is wrong and better to know now.
///
/// NOT production. There is no cap, no lease, and the owner can take anything.
contract AccountProbe {
    address public immutable owner;

    error NotOwner();
    error CallFailed(bytes data);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() { owner = msg.sender; }

    /// @notice Place an order on any venue that speaks the nine-argument shape.
    ///
    ///         Called with a raw encode rather than a typed interface for one
    ///         reason: this must be able to send VALUE with the order for a native
    ///         base asset, and the spot interface in this repo declares the function
    ///         non-payable. A typed call therefore cannot carry value at all, which
    ///         is precisely the thing question 3 is asking about.
    function trade(
        address venue,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint256 value
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        bytes memory payload = abi.encodeWithSignature(
            "placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)",
            isBid, userData, price, quantity, expireTimestampNs, orderType, uint8(0), address(0), uint96(0)
        );
        (bool success, bytes memory ret) = venue.call{value: value}(payload);
        if (!success) revert CallFailed(ret);
        (ok, orderId) = abi.decode(ret, (bool, uint128));
    }

    /// @notice Let a venue take a token out of this contract. Per order in the real
    ///         thing; unrestricted here so an experiment can set it up freely.
    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20Minimal(token).approve(spender, amount);
    }

    /// @notice Make an arbitrary call as this container.
    ///
    ///         Here only to answer the last open question: a perpetual needs margin
    ///         lodged with a separate desk BEFORE an order can be placed, and that
    ///         step has no dedicated helper here. Rather than guess whether one
    ///         container can serve perps too, let the experiment make the call.
    ///
    ///         A production container must NOT have this. It is exactly the escape
    ///         hatch the real design refuses to have, which is why the arena has no
    ///         owner-callable approve today.
    function exec(address target, bytes calldata data, uint256 value)
        external onlyOwner returns (bytes memory ret)
    {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
    }

    function sweep(address token, address to) external onlyOwner {
        IERC20Minimal t = IERC20Minimal(token);
        uint256 bal = t.balanceOf(address(this));
        if (bal > 0) t.transfer(to, bal);
    }

    function sweepNative(address to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert CallFailed("");
    }

    /// A venue that pays out in the chain's own coin sends it here.
    receive() external payable {}
}
