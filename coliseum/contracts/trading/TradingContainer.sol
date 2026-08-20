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
    error NativeOrderRefused();
    /// @notice A native order was not all-or-nothing. The coin is pushed with the
    ///         call, so a PARTIAL fill leaves the unfilled remainder at the venue
    ///         with no route back. Fill-or-kill removes the case entirely.
    error NativeOrderMustBeAllOrNothing(uint8 orderType);
    /// @notice The venue answered, but not with the two values this shape returns.
    ///         Raised instead of letting the decode fail unattributably — the same
    ///         swallowed-cause fault this contract's siblings were built to end.
    error UnexpectedVenueReply(bytes data);
    /// @notice The holding is smaller than the smallest quantity the venue trades.
    error BelowVenueMinimum(uint256 have, uint256 want);

    /// @notice Fired on every order placed through `trade` (directly or via
    ///         `settle`), win or refuse, so a refusal or a fill can be
    ///         reconstructed from logs after the fact — a mined transaction
    ///         exposes no ABI-decoded return value, only these.
    event OrderPlaced(address indexed venue, address indexed token, uint256 quantity, uint256 value, bool filled, uint128 orderId);
    event MarginFunded(address indexed bank, address indexed collateral, uint256 amount);
    /// @notice `asked` is what the desk was requested to release, `moved` is what
    ///         actually reached the owner — they differ when the desk refuses, or
    ///         when a rounding remainder was already sitting here.
    event MarginReclaimed(address indexed bank, address indexed collateral, uint256 asked, uint256 moved);
    /// @notice Fired by `settle` in addition to `OrderPlaced`, marking that
    ///         this particular order was a full-balance settlement rather
    ///         than an ordinary trade.
    event Settled(address indexed venue, address indexed asset, uint256 quantity, bool filled, uint128 orderId);
    /// @notice Fired by `settle` instead of `Settled` when there was nothing
    ///         to sell — distinct from a refusal, where an order WAS placed
    ///         and the venue said no.
    event NothingToSettle(address indexed venue, address indexed asset);
    event Recovered(address indexed asset, uint256 amount);

    /// @dev Fill-or-kill. All of it at this price or none of it — no partial fill,
    ///      which is what makes a native order safe to send value with.
    uint8 private constant ORDER_TYPE_FOK = 1;

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
        emit MarginFunded(bank, collateral, amount);
    }

    /// @notice Ask `bank` to release margin this container lodged, and bring
    ///         everything loose back to the owner.
    ///
    ///         THE COUNTERPART TO `fundMargin`, AND THE REASON THIS CONTRACT IS NOT
    ///         A ONE-WAY DOOR. Lodging margin moves cash off this contract and into
    ///         the desk; `recoverToken` only ever sees what SITS HERE. Without this
    ///         call, cash posted as margin could never come back, and since a
    ///         container is a fixed address that is never upgraded, one deployed
    ///         without a way out would never get one. That is the whole reason it
    ///         goes in before any container is leased to anything.
    ///
    ///         Modelled on `PerpAccount.reclaim`, deliberately, down to two details
    ///         that each cost real money to learn:
    ///
    ///         SIZE THE REQUEST BY FREE MARGIN, NEVER BY THE DESK'S OWN
    ///         "withdrawable" FIGURE. That figure ignores the margin an open
    ///         position still needs — measured reporting a full 25 USDso deposit
    ///         with a short open against it — so asking for what it reports is
    ///         refused outright and recovers NOTHING. Equity minus the initial
    ///         margin requirement is the real number, and it is read here rather
    ///         than trusted from the caller.
    ///
    ///         SWEEP THE WHOLE BALANCE, NOT THE AMOUNT ASKED FOR. A settlement
    ///         rounding remainder left behind would sit here forever, because after
    ///         a lease ends nothing looks at this address again.
    ///
    ///         A desk that REFUSES is tolerated rather than reverted on: the
    ///         release is the part that can fail, and losing the sweep along with
    ///         it would strand cash that had already arrived.
    /// @param amount a ceiling on what to ask the desk for, or 0 to ask for
    ///        everything free margin allows. Whatever the desk actually releases,
    ///        the whole balance follows it out.
    /// @return moved how much reached the owner.
    function reclaimMargin(address collateral, address bank, uint256 amount)
        external onlyOwner returns (uint256 moved)
    {
        uint256 want = _freeMarginAt(bank);
        if (amount > 0 && amount < want) want = amount;
        if (want > 0) {
            try IMarginBank(bank).withdraw(want) {} catch { /* keep the sweep below */ }
        }

        IERC20Minimal t = IERC20Minimal(collateral);
        moved = t.balanceOf(address(this));
        if (moved > 0) {
            if (!t.transfer(owner, moved)) revert TransferFailed();
            emit MarginReclaimed(bank, collateral, want, moved);
            emit Recovered(collateral, moved);
        }
    }

    /// @notice What this container could actually get back out of `bank` right now.
    ///
    ///         Equity minus the initial margin an open position needs. A desk that
    ///         cannot answer reports zero, so the caller above still runs its sweep
    ///         rather than reverting on a read.
    function freeMarginAt(address bank) external view returns (uint256) {
        return _freeMarginAt(bank);
    }

    function _freeMarginAt(address bank) internal view returns (uint256) {
        try IMarginBank(bank).getAccountHealth(address(this)) returns (
            int256 equity, uint256 imReq, uint256, uint256
        ) {
            if (equity <= 0) return 0;
            uint256 eq = uint256(equity);
            return eq > imReq ? eq - imReq : 0;
        } catch { return 0; }
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
    /// @param maxQuantity a ceiling on how much to offer in one go, or 0 for no
    ///        ceiling. This exists because these orders are all-or-nothing at the
    ///        venue: offering more than the resting depth cancels the WHOLE sale
    ///        rather than filling what it can. Measured 2026-08-20 while recycling
    ///        the house's own assets — 0.067 offered against a book holding 0.046
    ///        was refused outright, and the fix was to offer the depth instead.
    ///        Settling a large holding is therefore several calls, not one.
    function settle(
        address venue,
        address asset,
        uint256 price,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint256 maxQuantity
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        bool isNative = asset == address(0);
        uint256 qty = isNative ? address(this).balance : IERC20Minimal(asset).balanceOf(address(this));
        if (maxQuantity != 0 && qty > maxQuantity) qty = maxQuantity;

        // Round DOWN to a whole multiple of the venue's trading step. A venue only
        // accepts whole steps, and a raw balance almost never is one — so without
        // this the order is declined, the asset never reaches zero, and the pile-up
        // this function exists to end carries on. Worse for the coin: a decline
        // there reverts, so native settlement could never succeed at all.
        //
        // Asked of the venue rather than stored, so a re-pointed venue cannot leave
        // this rounding to a stale step. A venue that will not answer is settled
        // against unrounded, which is exactly today's behaviour.
        // Nothing held is not a failure — it is the state settlement is trying to
        // reach. Checked BEFORE the minimum below, so an already-empty container
        // reports quietly instead of reverting on a floor it can never meet.
        if (qty == 0) {
            emit NothingToSettle(venue, asset);
            return (false, 0);
        }

        (uint256 step, uint256 floorQty) = _stepFor(venue);
        if (step > 1) qty = (qty / step) * step;
        if (qty == 0 || qty < floorQty) revert BelowVenueMinimum(qty, floorQty);
        (ok, orderId) = _trade(
            venue, isNative ? address(0) : asset, isNative ? 0 : qty,
            false, uint64(0), price, qty, expireTimestampNs, orderType, isNative ? qty : 0
        );
        emit Settled(venue, asset, qty, ok, orderId);
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
        // The coin is pushed as part of this call, BEFORE the venue decides
        // anything. A partial fill therefore keeps everything that was pushed and
        // still reports success, so the refusal guard below would never fire and
        // the unfilled remainder would be stranded at the venue. Fill-or-kill has
        // no partial case at all, so requiring it removes the hazard rather than
        // trying to detect it after the fact — there is nothing in the reply that
        // would let this contract measure how much actually filled.
        if (value > 0 && orderType != ORDER_TYPE_FOK) revert NativeOrderMustBeAllOrNothing(orderType);

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
        // A call to an address with a fallback, or to a venue answering a different
        // shape, SUCCEEDS with data this cannot decode — and a bare decode failure
        // reverts with no reason at all. Naming it keeps the cause attributable,
        // which is the whole point of the sibling fixes in this change.
        if (ret.length != 64) revert UnexpectedVenueReply(ret);
        (ok, orderId) = abi.decode(ret, (bool, uint128));

        // Coin moves as part of the CALL itself, before the venue's own
        // accept/reject logic runs — so a graceful refusal (success == true,
        // ok == false) still leaves the value already sitting at the venue.
        // A token order is pull-based (the venue calls transferFrom) so a
        // refusal there costs nothing and may safely report ok == false. A
        // native order is push-based, so the only way a refusal can cost
        // nothing is to revert here and unwind the value transfer atomically
        // with the rest of this call.
        if (!ok && value > 0) revert NativeOrderRefused();

        emit OrderPlaced(venue, token, quantity, value, ok, orderId);
    }

    /// @dev The venue's trading step and its smallest acceptable order.
    ///
    ///      Two shapes exist and both are tried, because one container serves
    ///      several kinds of venue: a spot pool and an events desk answer a
    ///      seven-value parameter call, a perp book answers a three-value one. A
    ///      venue that answers neither returns (1, 0) — round nothing, refuse
    ///      nothing — leaving today's behaviour untouched rather than blocking a
    ///      settlement on a read this contract does not strictly need.
    function _stepFor(address venue) internal view returns (uint256 step, uint256 floorQty) {
        (bool ok1, bytes memory a) = venue.staticcall(abi.encodeWithSignature("getPoolParams()"));
        if (ok1 && a.length >= 224) {
            (, , , , , uint256 minQuantity, uint256 lotSize) =
                abi.decode(a, (address, address, uint256, uint256, uint256, uint256, uint256));
            return (lotSize == 0 ? 1 : lotSize, minQuantity);
        }
        (bool ok2, bytes memory b) = venue.staticcall(abi.encodeWithSignature("getOrderBookParameters()"));
        if (ok2 && b.length >= 96) {
            (, uint256 minQuantity, uint256 lotSize) = abi.decode(b, (uint256, uint256, uint256));
            return (lotSize == 0 ? 1 : lotSize, minQuantity);
        }
        return (1, 0);
    }

    /// @notice Move a token's whole balance back to the OWNER. Never any other
    ///         address — a recovery path, never a redirection.
    function recoverToken(address token) external onlyOwner returns (uint256 moved) {
        IERC20Minimal t = IERC20Minimal(token);
        moved = t.balanceOf(address(this));
        if (moved > 0) {
            if (!t.transfer(owner, moved)) revert TransferFailed();
            emit Recovered(token, moved);
        }
    }

    /// @notice Move the whole native-coin balance back to the OWNER. Never any
    ///         other address.
    function recoverNative() external onlyOwner returns (uint256 moved) {
        moved = address(this).balance;
        if (moved > 0) {
            (bool ok, ) = owner.call{value: moved}("");
            if (!ok) revert TransferFailed();
            emit Recovered(address(0), moved);
        }
    }

    /// A venue that pays out in the chain's own coin sends it here.
    receive() external payable {}
}
