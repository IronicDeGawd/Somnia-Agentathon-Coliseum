// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/ISpotPool.sol";
import "./interfaces/IBinaryPool.sol";

/// @title  EventDesk
/// @notice Makes one dreamDEX event-contract window look like an ordinary
///         Coliseum spot pool, so Arena can trade a prediction market without
///         knowing anything about binary markets.
///
/// Why this exists — three mismatches, all confirmed live on 2026-08-13:
///
///  1. WRITES DIFFER. A binary pool takes `placeBinaryOrder(kind, ...)`; the
///     generic `placeOrder` reverts. `kind` also carries the YES/NO axis that
///     `isBid` cannot express.
///
///  2. ORDER EXPIRY IS CAPPED. The pool enforces
///     `0 < expireNs <= marketExpiryNs` and reverts OrderExpiryBeyondMarket
///     (0xd3dea628) otherwise. Arena hard-codes a +3600s expiry, which is
///     longer than every 15-minute window and most 60-minute ones — so without
///     this clamp EVERY fighter trade would revert.
///
///  3. POOLS RECYCLE. Windows roll every 15 or 60 minutes and each gets a fresh
///     pool address, while Arena keys balances by pool address. One desk is
///     bound to one window for one duel, so the address Arena sees is stable
///     for as long as it matters.
///
/// Two further behaviours it has to paper over:
///
///  - PROCEEDS LAND IN THE WALLET. On a spot pool value stays in the vault; on
///    a binary pool fills, refunds and price improvement are paid to the
///    caller's address. Every trade sweeps them back into the vault so Arena's
///    `getWithdrawableBalance` check keeps agreeing with reality.
///
///  - A RESOLVED BOOK IS EMPTY. After settlement `getBookLevels` returns
///    nothing, which Arena would read as "this holding is worth zero" — bug H1,
///    firing by design on every duel. Once resolved the desk stops passing the
///    question through and answers from `payoutNumerators` instead.
///
///  - THE BOOK ALSO EMPTIES *BEFORE* EXPIRY. Observed live on 2026-08-13: a
///    15-minute BTC window sat with a completely empty book for the last ~7.5
///    minutes — half its life — while still in Trading status. No maker wants
///    to quote a binary about to settle. During that blackout the price is
///    unknown but the position is real, so the desk serves the last price it
///    saw with a quantity of ZERO: `midMarkPrice` reads the price and values
///    the holding correctly, while Arena's own `quantity == 0` check rejects
///    the trade instead of sending an order into a dead book.
///
/// SCALING. Coliseum thinks in 18-decimal USDso; the event pool is 6-decimal.
/// Everything crossing this boundary is scaled by SCALE (1e12), so Arena sees
/// prices where 1e18 == one whole contract == one unit of collateral.
///
/// TESTNET NOTE. Collateral here is tUSDC, a different token from Coliseum's
/// USDso, and no swap route exists between them. The desk funds itself from
/// tUSDC's open faucet and presents a 1:1 USDso-denominated face. On mainnet
/// the event collateral IS USDso and this shim goes away. It is safe because
/// Arena's `recoverFunds` pays from Arena's own balance capped by the duel pot,
/// so an event position can never cause an over-payment.
contract EventDesk is ISpotPool {

    // ─── Order kinds and types on the binary pool ─────────────────────────────
    uint8 private constant KIND_BUY_YES  = 0;
    uint8 private constant KIND_SELL_YES = 1;
    uint8 private constant ORDER_TYPE_IOC = 2;

    /// @dev 6-decimal pool -> 18-decimal Coliseum.
    uint256 public constant SCALE = 1e12;

    address public immutable owner;
    address public immutable arena;
    IBinaryPool public immutable pool;
    address public immutable collateral;
    IBinaryMarket public immutable market;
    IOutcomeToken6909 public immutable outcomeToken;
    uint256 public immutable yesId;
    uint256 public immutable oneCollateral;

    error NotArena();
    error NotOwner();
    error Unsupported();

    /// @notice Last non-empty top-of-book seen, in the pool's own 6 decimals.
    ///         Refreshed by `poke()` and by every trade. Serves as the price
    ///         during a maker blackout, when the book is empty but the market
    ///         has not settled and the position is still worth something.
    uint256 public lastGoodBid;
    uint256 public lastGoodAsk;

    event DeskFunded(uint256 amount6);
    event ProceedsSwept(uint256 amount6);
    event BookCached(uint256 bid6, uint256 ask6);

    modifier onlyArena() { if (msg.sender != arena) revert NotArena(); _; }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address _pool, address _arena) {
        owner = msg.sender;
        arena = _arena;
        pool  = IBinaryPool(_pool);

        BinaryPoolParams memory p = IBinaryPool(_pool).getBinaryPoolParams();
        collateral    = p.collateralToken;
        market        = IBinaryMarket(p.market);
        outcomeToken  = IOutcomeToken6909(p.outcomeToken);
        yesId         = p.yesId;
        oneCollateral = p.oneCollateral;

        // Selling escrows outcome tokens, which the pool pulls under an operator
        // grant on the ERC-6909 singleton. One grant covers every market and both
        // sides, so it is done once, here.
        IOutcomeToken6909(p.outcomeToken).setOperator(_pool, true);
    }

    // ─── Funding ──────────────────────────────────────────────────────────────

    /// @notice Pull `amount6` of testnet collateral from the open faucet and put
    ///         it in the pool vault, where orders draw from.
    function fundFromFaucet(uint256 amount6) public onlyOwner {
        _fund(amount6);
    }

    function _fund(uint256 amount6) internal {
        ITestCollateral(collateral).faucet(amount6);
        ITestCollateral(collateral).approve(address(pool), amount6);
        pool.deposit(collateral, amount6);
        emit DeskFunded(amount6);
    }

    /// @dev Anything the pool paid to this address (fills, refunds, price
    ///      improvement) goes back into the vault, because Arena's affordability
    ///      check reads the vault and nothing else.
    function _sweep() internal {
        uint256 loose = ITestCollateral(collateral).balanceOf(address(this));
        if (loose == 0) return;
        ITestCollateral(collateral).approve(address(pool), loose);
        pool.deposit(collateral, loose);
        emit ProceedsSwept(loose);
    }

    // ─── ISpotPool: the face Arena sees ───────────────────────────────────────

    /// @notice Arena calls this naming USDso. The desk cannot hold USDso against
    ///         this market, so it funds the equivalent from the faucet instead
    ///         and ignores the token argument. See the testnet note above.
    function deposit(address, uint256 amount) external override {
        _fund(amount / SCALE);
    }

    function withdraw(address, uint256 amount) external override onlyOwner {
        pool.withdraw(collateral, amount / SCALE);
    }

    function depositNative() external payable override { revert Unsupported(); }

    function getWithdrawableBalance(address user, address) external view override returns (uint256) {
        // Arena asks about its own balance; the vault position is held by the desk.
        address who = user == arena ? address(this) : user;
        return pool.getWithdrawableBalance(who, collateral) * SCALE;
    }

    /// @notice Top of book, scaled to 18 decimals — or the settled payout once
    ///         the window has resolved, because a resolved book is empty and
    ///         Arena would otherwise value a real holding at zero.
    function getBookLevels(bool isBid, uint64 numLevels)
        external view override returns (OrderBookLevel[] memory)
    {
        uint256 settled = _resolvedPrice18();
        if (settled != type(uint256).max) {
            OrderBookLevel[] memory one = new OrderBookLevel[](1);
            // Quantity is nominal: this level exists to carry a price, not to be
            // traded against. A resolved market accepts no orders.
            one[0] = OrderBookLevel({ price: settled, quantity: type(uint128).max });
            return one;
        }

        OrderBookLevel[] memory raw = pool.getBookLevels(isBid, numLevels);
        if (raw.length > 0) {
            OrderBookLevel[] memory out = new OrderBookLevel[](raw.length);
            for (uint256 i = 0; i < raw.length; i++) {
                out[i] = OrderBookLevel({ price: raw[i].price * SCALE, quantity: raw[i].quantity * SCALE });
            }
            return out;
        }

        // Maker blackout: the book is empty but the market has not settled, so
        // the position is still worth roughly what it was worth a moment ago.
        // Quantity zero is the honest part — there is a price, but nothing to
        // trade against, and Arena's own check turns that into a clean reject.
        uint256 cached = isBid ? lastGoodBid : lastGoodAsk;
        if (cached > 0) {
            OrderBookLevel[] memory stale = new OrderBookLevel[](1);
            stale[0] = OrderBookLevel({ price: cached * SCALE, quantity: 0 });
            return stale;
        }
        return raw;
    }

    /// @notice Refresh the cached top-of-book. Permissionless and cheap — the
    ///         watcher calls it each turn so a blackout that starts mid-duel is
    ///         still backed by a recent price rather than a stale one.
    function poke() public {
        _cacheBook();
    }

    function _cacheBook() internal {
        uint256 bid;
        uint256 ask;
        try pool.getBookLevels(true, 1) returns (OrderBookLevel[] memory b) {
            if (b.length > 0) bid = b[0].price;
        } catch {}
        try pool.getBookLevels(false, 1) returns (OrderBookLevel[] memory a) {
            if (a.length > 0) ask = a[0].price;
        } catch {}
        if (bid == 0 && ask == 0) return;      // nothing better to remember
        if (bid > 0) lastGoodBid = bid;
        if (ask > 0) lastGoodAsk = ask;
        emit BookCached(lastGoodBid, lastGoodAsk);
    }

    /// @return baseToken quoteToken makerFee takerFee tickSize minQuantity lotSize
    function getPoolParams() external view override returns (
        address, address, uint256, uint256, uint256, uint256, uint256
    ) {
        BinaryPoolParams memory p = pool.getBinaryPoolParams();
        OrderBookParams  memory g = pool.getOrderBookParameters();
        return (
            p.outcomeToken,          // "base" is the YES position
            p.collateralToken,
            p.makerFeeBpsTimes1k,
            p.takerFeeBpsTimes1k,
            g.tickSize   * SCALE,
            g.minQuantity * SCALE,
            g.lotSize    * SCALE
        );
    }

    /// @notice Arena's order, translated. `isBid` becomes BUY_YES / SELL_YES and
    ///         Arena's expiry is discarded in favour of the market's own.
    function placeOrder(
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  /* expireTimestampNs — deliberately ignored, see below */,
        uint8   /* orderType */,
        uint8   selfMatchingOption,
        address builder,
        uint96  builderFeeBpsTimes1k
    ) external override onlyArena returns (bool success, uint128 orderId) {
        // Remember the book we are about to trade into, so a blackout starting
        // after this turn still has a recent price behind it.
        _cacheBook();

        // The pool rejects any expiry past its own, so Arena's +3600s is replaced
        // rather than forwarded. Taker semantics (IOC) match Arena's intent.
        uint64 expiry = pool.marketExpiryNs();

        (success, orderId) = pool.placeBinaryOrder(
            isBid ? KIND_BUY_YES : KIND_SELL_YES,
            price / SCALE,
            quantity / SCALE,
            expiry,
            ORDER_TYPE_IOC,
            selfMatchingOption,
            builder,
            builderFeeBpsTimes1k,
            userData
        );

        _sweep();
    }

    function cancelOrder(uint128 orderId) external override onlyArena {
        pool.cancelOrder(orderId);
        _sweep();
    }

    // ─── Settlement ───────────────────────────────────────────────────────────

    /// @notice YES price in 18 decimals once the window has settled, or
    ///         type(uint256).max while it is still trading.
    /// @dev    Resolved pays one-hot (1e18 or 0); voided pays both sides half.
    function resolvedPrice18() external view returns (uint256) { return _resolvedPrice18(); }

    function _resolvedPrice18() internal view returns (uint256) {
        // A market that cannot answer is treated as still trading, so the desk
        // never invents a price it does not have.
        try market.isResolved() returns (bool resolved) {
            if (!resolved) {
                try market.isVoided() returns (bool voided) {
                    if (!voided) return type(uint256).max;
                } catch { return type(uint256).max; }
            }
        } catch { return type(uint256).max; }

        try market.payoutNumerators() returns (uint256[] memory nums) {
            if (nums.length < 2) return type(uint256).max;
            uint256 total = nums[0] + nums[1];
            if (total == 0) return type(uint256).max;
            return (nums[0] * 1e18) / total;   // index 0 = YES/Up
        } catch { return type(uint256).max; }
    }

    /// @notice YES contracts this desk holds, in 18 decimals.
    function yesBalance18() external view returns (uint256) {
        return outcomeToken.balanceOf(address(this), yesId) * SCALE;
    }
}
