// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20Minimal.sol";
import "../interfaces/ISpotPool.sol";

/// @title  FuelPot — turns stablecoin revenue into the coin that pays for thinking.
///
/// @notice Players pay in stablecoin. The fighters' reasoning is billed in the
///         chain's own coin, attached to every request for a decision. Nothing
///         converted one into the other, so the Arena's coin balance was refilled
///         by hand from an operator's wallet, and the entry fee — priced explicitly
///         to track inference cost, and measured at six to eleven times what the
///         thinking actually costs — could never reach the thing it was named for.
///
///         The route was always there. One of the game's own markets trades the
///         chain's coin against the stablecoin. Verified on 2026-08-20:
///         150.4831 -> 150.3862 stablecoin, 3.0752 -> 4.0715 coin, one order, no
///         bridge and no operator (tx 0x55a8717f…). The book was offering 484.5
///         coin against a fifteen-round fight's need of about 3.6.
///
///         So this pot holds the fee, buys coin with it, and tops the Arena up.
///
/// @dev WHY THIS IS A SEPARATE CONTRACT. The Arena's stablecoin balance already
///      carries two claims: players' escrowed stakes and the owner's seed. Leaving
///      a third — money earmarked for thinking — in the same balance would mean the
///      buy gate had to subtract it too, or a fighter's purchase could quietly
///      spend the thinking budget. One balance serving several purposes is the exact
///      fault the spot venue work spent a day removing; rebuilding it here for fuel
///      would be the same mistake in a new coat.
contract FuelPot {
    /// @notice The stablecoin the fee arrives in, and the market that trades the
    ///         chain's own coin against it.
    IERC20Minimal public immutable stablecoin;

    address public owner;
    /// @notice Two-step handover. A one-step transfer to a mistyped address hands
    ///         this contract to someone who cannot act, and everything in it is then
    ///         unreachable forever. The successor must accept.
    address public pendingOwner;

    /// @notice Where bought coin is sent, and the market it is bought on. Both
    ///         settable, because a redeployed Arena or a re-pointed market must not
    ///         require redeploying the pot and migrating its balance.
    address public arena;
    address public market;

    /// @notice Top the Arena up to this much coin, and only act below the floor.
    ///         A band rather than a single number, so a caller cannot make the house
    ///         trade on every block by keeping it a hair under target.
    uint256 public targetCoin = 40e18;
    uint256 public floorCoin  = 25e18;

    /// @notice Most stablecoin one call may spend, and the worst price it may accept
    ///         above the best offer, in hundredths of a percent.
    ///
    ///         `refuel` is deliberately callable by anyone — a pot only the owner can
    ///         fill is a pot that runs dry at three in the morning. That means these
    ///         two numbers are the entire defence against someone using this contract
    ///         as a way to make the house buy badly: they bound how much can move and
    ///         how far through the book it may reach, per call.
    uint256 public maxSpendPerCall = 25e18;
    uint256 public maxPremiumBps   = 200;

    event Refuelled(address indexed caller, uint256 spent, uint256 coinBought, uint256 sentToArena);
    event RefuelSkipped(string reason);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Migrated(address indexed successor, uint256 stableMoved, uint256 coinMoved);
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);
    event ConfigChanged(string what);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();
    error ApproveFailed();
    error BadBand(uint256 floorCoin, uint256 targetCoin);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address stablecoin_, address market_, address arena_) {
        if (stablecoin_ == address(0) || market_ == address(0)) revert ZeroAddress();
        stablecoin = IERC20Minimal(stablecoin_);
        market     = market_;
        arena      = arena_;
        owner      = msg.sender;
    }

    // ─── Refuel ───────────────────────────────────────────────────────────────

    /// @notice Buy coin with the fee and send it to the Arena. Callable by anyone.
    ///
    ///         Returns quietly rather than reverting on every "nothing to do" case,
    ///         so a keeper can call this on a timer without a stream of failures, and
    ///         so a caller learns WHY from a log rather than an opaque revert.
    /// @return bought how much coin reached the Arena.
    function refuel() external returns (uint256 bought) {
        if (arena == address(0)) { emit RefuelSkipped("no arena set"); return 0; }

        uint256 have = arena.balance;
        if (have >= floorCoin) { emit RefuelSkipped("arena above floor"); return 0; }

        uint256 want = targetCoin - have;
        uint256 purse = stablecoin.balanceOf(address(this));
        if (purse == 0) { emit RefuelSkipped("pot is empty"); return 0; }

        // What the market is asking, and how much of it there is. These orders are
        // all-or-nothing, so offering more than the resting size cancels the whole
        // purchase rather than filling part of it — measured the hard way while
        // recycling the house's own assets.
        (uint256 price, uint256 available, uint256 step) = _quote();
        if (price == 0) { emit RefuelSkipped("nobody offering coin"); return 0; }

        uint256 qty = want < available ? want : available;
        if (step > 1) qty = (qty / step) * step;
        if (qty == 0) { emit RefuelSkipped("below the market's smallest order"); return 0; }

        // Cap the spend, then re-cap the quantity to what that spend actually buys —
        // in that order, because capping the spend alone would leave an order the
        // purse cannot pay for, and the venue would take the money it can and fail.
        uint256 cost = (price * qty) / 1e18;
        uint256 ceiling = maxSpendPerCall < purse ? maxSpendPerCall : purse;
        if (cost > ceiling) {
            qty = (ceiling * 1e18) / price;
            if (step > 1) qty = (qty / step) * step;
            if (qty == 0) { emit RefuelSkipped("spend cap below one order"); return 0; }
            cost = (price * qty) / 1e18;
        }

        uint256 before = address(this).balance;
        if (!stablecoin.approve(market, cost)) revert ApproveFailed();
        bool filled;
        try ISpotPool(market).placeOrder(
            true, 0, price, qty, uint64(block.timestamp + 300) * 1_000_000_000, 1, 0, address(0), 0
        ) returns (bool ok, uint128) {
            filled = ok;
        } catch {
            filled = false;
        }
        // Never leave an allowance standing on a market that may later be re-pointed.
        if (!stablecoin.approve(market, 0)) revert ApproveFailed();

        uint256 gained = address(this).balance - before;
        if (!filled || gained == 0) { emit RefuelSkipped("the market declined"); return 0; }

        // Forward everything held, not just this purchase: a remainder from an
        // earlier partial delivery would otherwise sit here indefinitely.
        uint256 send = address(this).balance;
        (bool sent, ) = arena.call{value: send}("");
        if (!sent) revert TransferFailed();

        emit Refuelled(msg.sender, cost, gained, send);
        return send;
    }

    /// @notice What one order would cost right now — price, resting size, and the
    ///         market's trading step. Zero price means nothing is on offer.
    function quote() external view returns (uint256 price, uint256 available, uint256 step) {
        return _quote();
    }

    /// @notice Everything a caller or a dashboard needs to decide whether to act.
    function status() external view returns (
        uint256 arenaCoin, uint256 potStable, uint256 potCoin, bool wouldAct
    ) {
        arenaCoin = arena == address(0) ? 0 : arena.balance;
        potStable = stablecoin.balanceOf(address(this));
        potCoin   = address(this).balance;
        wouldAct  = arena != address(0) && arenaCoin < floorCoin && potStable > 0;
    }

    function _quote() internal view returns (uint256 price, uint256 available, uint256 step) {
        uint256 minQuantity;
        try ISpotPool(market).getPoolParams() returns (
            address, address, uint256, uint256, uint256 tickSize, uint256 minQty, uint256 lotSize
        ) {
            step = lotSize == 0 ? 1 : lotSize;
            minQuantity = minQty;
            if (tickSize == 0) return (0, 0, step);
            try ISpotPool(market).getBookLevels(false, 1) returns (OrderBookLevel[] memory lv) {
                if (lv.length == 0 || lv[0].quantity == 0) return (0, 0, step);
                // Cross by the allowed premium, then land on a tick. Bounded, because
                // anyone may call refuel and an unbounded cross is a way to make the
                // house pay anything the book asks.
                uint256 p = lv[0].price + (lv[0].price * maxPremiumBps) / 10_000;
                p = (p / tickSize) * tickSize;
                if (p == 0) return (0, 0, step);
                available = lv[0].quantity < minQuantity ? 0 : lv[0].quantity;
                return (p, available, step);
            } catch { return (0, 0, step); }
        } catch { return (0, 0, 1); }
    }

    // ─── Owner: configuration ────────────────────────────────────────────────

    function setArena(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        arena = a;
        emit ConfigChanged("arena");
    }

    function setMarket(address m) external onlyOwner {
        if (m == address(0)) revert ZeroAddress();
        market = m;
        emit ConfigChanged("market");
    }

    function setBand(uint256 floor_, uint256 target_) external onlyOwner {
        // A floor at or above target would make every call act, which is the
        // griefing shape these two numbers exist to prevent.
        if (floor_ == 0 || target_ <= floor_) revert BadBand(floor_, target_);
        floorCoin = floor_;
        targetCoin = target_;
        emit ConfigChanged("band");
    }

    function setLimits(uint256 maxSpend, uint256 premiumBps) external onlyOwner {
        if (maxSpend == 0) revert ZeroAmount();
        // A premium of a whole percent-thousand would be an unbounded cross in
        // practice. Ten percent is already far beyond any healthy book here.
        if (premiumBps > 1_000) revert ZeroAmount();
        maxSpendPerCall = maxSpend;
        maxPremiumBps = premiumBps;
        emit ConfigChanged("limits");
    }

    // ─── Owner: the way out ──────────────────────────────────────────────────

    /// @notice Take anything in this pot back out, in full if asked.
    ///
    /// @dev UNCAPPED ON PURPOSE, and safe here in a way it would NOT be in the
    ///      Arena. The distinction is what the contract holds, not who is asking.
    ///      The Arena's balance contains players' escrowed stakes, so an
    ///      unrestricted owner drain there would be theft and its cap exists for
    ///      exactly that reason. This pot holds nothing but house money earmarked
    ///      for the fighters' thinking — there is no player deposit in here to
    ///      protect, so a cap would only ever strand the house's own money.
    ///
    ///      Do not "helpfully" add a cap here, and do not copy this function into a
    ///      contract that holds anyone else's money.
    /// @param token the stablecoin, or the zero address for the chain's own coin.
    function ownerWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
        }
        emit Withdrawn(token, to, amount);
    }

    /// @notice Move everything to a successor pot in one call.
    ///
    /// @dev An upgrade should be one transaction, not a checklist someone
    ///      half-finishes. Two amounts are stranded in superseded contracts in this
    ///      project already, both because moving money out was a manual sequence
    ///      rather than a single call.
    function migrate(address successor) external onlyOwner returns (uint256 stableMoved, uint256 coinMoved) {
        if (successor == address(0)) revert ZeroAddress();
        stableMoved = stablecoin.balanceOf(address(this));
        if (stableMoved > 0 && !stablecoin.transfer(successor, stableMoved)) revert TransferFailed();
        coinMoved = address(this).balance;
        if (coinMoved > 0) {
            (bool ok, ) = successor.call{value: coinMoved}("");
            if (!ok) revert TransferFailed();
        }
        emit Migrated(successor, stableMoved, coinMoved);
    }

    // ─── Owner: handover ─────────────────────────────────────────────────────

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnerTransferStarted(owner, to);
    }

    /// @notice The successor claims it. Two steps, because a one-step transfer to a
    ///         mistyped address makes everything in here permanently unreachable.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address from = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerTransferred(from, owner);
    }

    /// The market delivers the chain's own coin by sending it here.
    receive() external payable {}
}
