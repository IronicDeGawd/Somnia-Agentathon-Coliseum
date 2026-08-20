// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20Minimal.sol";
import "../interfaces/IPerps.sol";

/// @title  TradingContainer
/// @notice A house-funded, owner-only container that holds tokens and the chain's
///         own coin and places orders on any venue speaking the nine-argument
///         `placeOrder` shape — spot, an events desk, or (with margin lodged first)
///         a perpetual.
///
///         What `contracts/probe/AccountProbe.sol` set out to answer, made safe to
///         actually deploy. Same order-encoding trick — a raw `abi.encodeWithSignature`
///         rather than a typed interface, because the typed spot interface declares
///         `placeOrder` non-payable and a native-base sell needs to send value with
///         the order — but with the probe's `exec` escape hatch removed entirely.
///         There is no owner-callable arbitrary call here, on purpose: that hatch
///         is exactly what a container touching a live fight must never have.
contract TradingContainer {
    address public immutable owner;

    error NotOwner();
    error OrderFailed(bytes data);
    error ApproveFailed();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() { owner = msg.sender; }

    /// @notice Place an order on any venue that speaks the nine-argument shape —
    ///         spot, an events desk, or (once margin is lodged) a perp market.
    ///
    ///         Raw-encoded rather than called through a typed interface for the
    ///         same reason `AccountProbe.trade` was: this must be able to send
    ///         VALUE with the order for a native-base sell, and the typed spot
    ///         interface in this repo declares the function non-payable.
    ///
    ///         `token` is the asset this order needs an allowance for before the
    ///         venue can pull it — the quote token when buying, the base token
    ///         when selling a non-native base, or the zero address when the order
    ///         is funded entirely by `value` (a native-base sell) or already funded
    ///         through a margin bank. `approveAmount` is a SEPARATE parameter from
    ///         `quantity` on purpose: a buy pulls the notional (price × quantity of
    ///         the QUOTE token), not the base `quantity` being bought, so the two
    ///         can differ by orders of magnitude. The approval is granted for
    ///         exactly this order and reset to zero afterwards — win, lose, or
    ///         revert — so nothing is ever left standing.
    function trade(
        address venue,
        address token,
        uint256 approveAmount,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint256 value
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        return _trade(venue, token, approveAmount, isBid, userData, price, quantity, expireTimestampNs, orderType, value);
    }

    /// @notice Lodge `amount` of `collateral`, already sitting in this contract,
    ///         with `bank` as this account's own margin — the one job the order
    ///         shape in `trade` cannot do, because it is not an order. A perp
    ///         trade is then `fundMargin` followed by an ordinary `trade` call
    ///         against the perp pool, which speaks the same nine-argument shape.
    ///         Kept as its own entry point rather than folded into `trade` because
    ///         lodging margin deserves a dedicated, narrowly-typed call rather
    ///         than a generic escape hatch guessing at what a desk needs done
    ///         first.
    ///
    ///         THE ZERO-ALLOWANCE RULE, mirrored from `PerpAccount.fund`: when an
    ///         order needs more margin than this account holds, the protocol tries
    ///         to `transferFrom` the trader's own balance rather than simply
    ///         refusing — measured once as `ERC20InsufficientAllowance(bank, 0,
    ///         8.27e18)`. Leaving the deposit allowance standing would let an
    ///         overdraw silently raid the float, so it is set back to zero here
    ///         whether or not the deposit itself needed all of it.
    function fundMargin(address collateral, address bank, uint256 amount) external onlyOwner {
        if (!IERC20Minimal(collateral).approve(bank, amount)) revert ApproveFailed();
        IMarginBank(bank).deposit(amount);
        if (!IERC20Minimal(collateral).approve(bank, 0)) revert ApproveFailed();
    }

    /// @notice Sell the WHOLE current holding of `asset` back into `venue`, at
    ///         `price`, converting it back to cash in one call.
    ///
    ///         Without this a purchase only ever turns cash into an asset, and a
    ///         cupboard of these containers slowly fills with things nothing ever
    ///         converts — the same drain the whole engine exists to end, rebuilt
    ///         one level up. Selling the FULL balance rather than a caller-supplied
    ///         quantity is deliberate: it is the only way this call can guarantee
    ///         the asset lands at zero rather than depending on the caller reading
    ///         the balance correctly first.
    /// @param asset `address(0)` to settle the chain's own coin — the sale the
    ///        probe proved unlocks a complete settlement for the first time,
    ///        since selling native means sending it WITH the order.
    function settle(
        address venue,
        address asset,
        uint256 price,
        uint64  expireTimestampNs,
        uint8   orderType
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        bool isNative = asset == address(0);
        uint256 qty = isNative ? address(this).balance : IERC20Minimal(asset).balanceOf(address(this));
        if (qty == 0) return (false, 0);
        return _trade(
            venue, isNative ? address(0) : asset, isNative ? 0 : qty,
            false, uint64(0), price, qty, expireTimestampNs, orderType, isNative ? qty : 0
        );
    }

    function _trade(
        address venue,
        address token,
        uint256 approveAmount,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint256 value
    ) internal returns (bool ok, uint128 orderId) {
        bool approved = token != address(0) && approveAmount > 0;
        if (approved) {
            if (!IERC20Minimal(token).approve(venue, approveAmount)) revert ApproveFailed();
        }

        bytes memory payload = abi.encodeWithSignature(
            "placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)",
            isBid, userData, price, quantity, expireTimestampNs, orderType, uint8(0), address(0), uint96(0)
        );
        (bool success, bytes memory ret) = venue.call{value: value}(payload);

        // Re-zero the allowance regardless of outcome, so a refused order never
        // leaves a standing approval behind.
        if (approved) {
            if (!IERC20Minimal(token).approve(venue, 0)) revert ApproveFailed();
        }

        if (!success) revert OrderFailed(ret);
        (ok, orderId) = abi.decode(ret, (bool, uint128));
    }

    /// @notice Move a token's whole balance back to the OWNER. Never any other
    ///         address — a recovery path, never a redirection.
    function recoverToken(address token) external onlyOwner returns (uint256 moved) {
        IERC20Minimal t = IERC20Minimal(token);
        moved = t.balanceOf(address(this));
        if (moved > 0 && !t.transfer(owner, moved)) revert TransferFailed();
    }

    /// @notice Move the whole native-coin balance back to the OWNER. Never any
    ///         other address.
    function recoverNative() external onlyOwner returns (uint256 moved) {
        moved = address(this).balance;
        if (moved > 0) {
            (bool ok, ) = owner.call{value: moved}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// A venue that pays out in the chain's own coin sends it here.
    receive() external payable {}
}
