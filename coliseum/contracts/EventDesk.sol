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
/// SCALING. Coliseum thinks in 18-decimal USDso; the event pool quotes in its
/// collateral's decimals, which is 6 on this testnet. Everything crossing the
/// boundary is multiplied or divided by `scale`, so Arena sees prices where
/// 1e18 == one whole contract == one unit of collateral.
///
/// `scale` is DERIVED at bind() from the pool's own `oneCollateral`, not fixed at
/// compile time. It used to be `constant 1e12`, which is right only for 6-decimal
/// collateral: a port to 18-decimal USDso would have mispriced every order, book
/// level and balance by a factor of a trillion, with nothing to notice. The pool
/// has always reported its own unit; the constant just ignored it. Deriving it
/// also lets two desks serve markets with different collateral at the same time,
/// which a constant can never do.
///
/// TESTNET NOTE. Collateral here is tUSDC, a different token from Coliseum's
/// USDso, and no swap route exists between them. The desk funds itself from
/// tUSDC's open faucet and presents a 1:1 USDso-denominated face. On mainnet the
/// event collateral IS USDso, `oneCollateral` is 1e18 and `scale` becomes 1, so
/// the arithmetic below turns into a no-op on its own. It is safe because Arena's
/// `recoverFunds` pays from Arena's own balance capped by the duel pot, so an
/// event position can never cause an over-payment.
contract EventDesk is ISpotPool {

    // ─── Order kinds and types on the binary pool ─────────────────────────────
    uint8 private constant KIND_BUY_YES  = 0;
    uint8 private constant KIND_SELL_YES = 1;
    uint8 private constant ORDER_TYPE_IOC = 2;

    /// @notice Coliseum's unit — one whole contract, one unit of collateral.
    uint256 public constant ONE18 = 1e18;

    /// @notice Pool collateral unit -> Coliseum's 18 decimals. Set by bind() from
    ///         the market's own `oneCollateral`; 1e12 for 6-decimal collateral, 1
    ///         for 18-decimal. Zero until the first bind, and every path that uses
    ///         it is either `bound` or reads through the pool, which reverts first.
    uint256 public scale;

    address public immutable owner;
    address public immutable arena;

    // ─── The bound window ─────────────────────────────────────────────────────
    // Mutable, because one desk serves many duels. Arena keys every balance and
    // snapshot by duelId as well as pool address, so re-pointing a desk BETWEEN
    // duels collides with nothing. Re-pointing it DURING one would be corruption,
    // which is what `inUse` prevents.
    IBinaryPool public pool;
    address public collateral;
    IBinaryMarket public market;
    IOutcomeToken6909 public outcomeToken;
    uint256 public yesId;
    uint256 public oneCollateral;

    /// @notice True while a duel holds this desk. Set by the owner at duel start
    ///         and cleared at the end; `bind` refuses to move a desk in use.
    bool public inUse;

    error NotArena();
    error NotOwner();
    error Unsupported();
    error NotBound();
    error DeskInUse();
    error PositionOutstanding();
    error MarketIdRequired();
    /// @dev The market's collateral unit has no exact whole-number factor into 1e18.
    error UnsupportedCollateralUnit(uint256 oneCollateral);

    /// @notice Last non-empty top-of-book seen, in the pool's own 6 decimals.
    ///         Refreshed by `poke()` and by every trade. Serves as the price
    ///         during a maker blackout, when the book is empty but the market
    ///         has not settled and the position is still worth something.
    uint256 public lastGoodBid;
    uint256 public lastGoodAsk;

    /// @notice The bound window's identity in the claims registry. Supplied at
    ///         bind time because it is published only in the MarketCreated log
    ///         and cannot be read back off the pool — without it a settled
    ///         position can never be claimed.
    bytes32 public marketId;

    /// @notice Where settled positions are claimed. Distinct from the pool,
    ///         which is only where trading happens.
    IBinaryMarketsModule public immutable module;

    event DeskBound(address indexed pool, bytes32 indexed marketId, uint256 yesId);
    event DeskAcquired(bool inUse);
    event DeskFunded(uint256 amount6);
    event ProceedsSwept(uint256 amount6);
    event BookCached(uint256 bid6, uint256 ask6);
    event PositionRedeemed(bytes32 indexed marketId, uint256 contracts6, uint256 collected6);

    modifier onlyArena() { if (msg.sender != arena) revert NotArena(); _; }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier bound()     { if (address(pool) == address(0)) revert NotBound(); _; }

    constructor(address _arena, address _module) {
        owner  = msg.sender;
        arena  = _arena;
        module = IBinaryMarketsModule(_module);
    }

    // ─── Binding ──────────────────────────────────────────────────────────────

    /// @notice Point this desk at a market window. Called at duel start with
    ///         whatever window is live — a future one cannot be bound because
    ///         dreamDEX creates each window only as the previous one expires.
    /// @dev    Retreats from the previous window first, so collateral is never
    ///         stranded in the vault of a pool nobody is watching any more.
    /// @param _marketId The window's id in the claims registry. Read from the
    ///        MarketCreated log by the caller — the pool does not expose it, and
    ///        without it this desk could never claim what it wins.
    function bind(address _pool, bytes32 _marketId) external onlyOwner {
        if (inUse) revert DeskInUse();
        if (_marketId == bytes32(0)) revert MarketIdRequired();

        if (address(pool) != address(0)) {
            // Try to collect anything already won before walking away. Only if
            // value is still stuck afterwards do we refuse to move — abandoning
            // it would bleed the treasury one duel at a time, invisibly.
            _redeemSettled();
            if (outcomeToken.balanceOf(address(this), yesId) != 0) revert PositionOutstanding();
            uint256 left = pool.getWithdrawableBalance(address(this), collateral);
            if (left > 0) pool.withdraw(collateral, left);
        }

        BinaryPoolParams memory p = IBinaryPool(_pool).getBinaryPoolParams();
        marketId      = _marketId;
        pool          = IBinaryPool(_pool);
        collateral    = p.collateralToken;
        market        = IBinaryMarket(p.market);
        outcomeToken  = IOutcomeToken6909(p.outcomeToken);
        yesId         = p.yesId;
        oneCollateral = p.oneCollateral;

        // The market states its own unit; refuse anything we cannot represent
        // exactly rather than silently rounding every price. Collateral finer than
        // 18 decimals, or a unit that is not a power of ten, has no whole-number
        // factor into Coliseum's 18 and would corrupt every conversion below.
        if (p.oneCollateral == 0 || p.oneCollateral > ONE18 || ONE18 % p.oneCollateral != 0) {
            revert UnsupportedCollateralUnit(p.oneCollateral);
        }
        scale = ONE18 / p.oneCollateral;

        // A fresh window has its own price history; carrying the last one's
        // cached book across would misvalue the new position.
        lastGoodBid = 0;
        lastGoodAsk = 0;

        // Selling escrows outcome tokens, which the pool pulls under an operator
        // grant on the ERC-6909 singleton. One grant covers every market and both
        // sides, but each new pool needs its own grant.
        IOutcomeToken6909(p.outcomeToken).setOperator(_pool, true);

        // Whatever we retreated with goes into the new vault.
        _sweep();
        emit DeskBound(_pool, _marketId, p.yesId);
    }

    // ─── Claiming a settled position ──────────────────────────────────────────

    /// @notice Collect the collateral behind a winning position and put it back
    ///         in the trading pot. Nothing is pushed to us on settlement — the
    ///         protocol holds the money until it is asked for.
    ///
    ///         Permissionless: it can only ever move OUR own winnings INTO our
    ///         own vault, so there is nothing to gain by calling it and real
    ///         value at stake if nobody does. The watcher calls it when a duel
    ///         ends; `bind` calls it too, so a desk is never stuck behind an
    ///         uncollected win.
    /// @return collected6 collateral recovered, in the pool's own decimals.
    function redeemSettled() external bound returns (uint256 collected6) {
        return _redeemSettled();
    }

    function _redeemSettled() internal returns (uint256 collected6) {
        uint256 held = outcomeToken.balanceOf(address(this), yesId);
        if (held == 0) return 0;

        // Claiming before the market has settled is meaningless — and the whole
        // position may still be tradable, so do not disturb it.
        if (_resolvedPrice18() == type(uint256).max) return 0;

        uint256 before = IERC20Like(collateral).balanceOf(address(this));

        // The claims registry pulls the outcome tokens, so it needs its own
        // grant — the one given to the pool at bind time does not cover it.
        if (!outcomeToken.isOperator(address(this), address(module))) {
            outcomeToken.setOperator(address(module), true);
        }

        // A losing position is worth nothing and the registry may refuse it
        // outright; either way there is nothing to collect, so failure here
        // must not block the caller. Outcome 0 is YES/Up, the only side we hold.
        try module.redeem(0, bytes32(0), marketId, 0, held) {
            collected6 = IERC20Like(collateral).balanceOf(address(this)) - before;
            _sweep();
            emit PositionRedeemed(marketId, held, collected6);
        } catch {
            return 0;
        }
    }

    /// @notice Claim/release the desk for a duel. `bind` is refused while held.
    function setInUse(bool held) external onlyOwner {
        inUse = held;
        emit DeskAcquired(held);
    }

    // ─── Funding ──────────────────────────────────────────────────────────────

    /// @notice Move `amount6` of collateral from the caller into the pool vault,
    ///         where orders draw from. The caller is an EventTreasury on testnet
    ///         and Arena's own funding path on mainnet — the desk does not care
    ///         which, and deliberately knows nothing about faucets.
    function fund(uint256 amount6) external bound {
        IERC20Like(collateral).transferFrom(msg.sender, address(this), amount6);
        _sweep();
        emit DeskFunded(amount6);
    }

    /// @dev Anything the pool paid to this address (fills, refunds, price
    ///      improvement) goes back into the vault, because Arena's affordability
    ///      check reads the vault and nothing else.
    function _sweep() internal {
        uint256 loose = IERC20Like(collateral).balanceOf(address(this));
        if (loose == 0) return;
        IERC20Like(collateral).approve(address(pool), loose);
        pool.deposit(collateral, loose);
        emit ProceedsSwept(loose);
    }

    // ─── ISpotPool: the face Arena sees ───────────────────────────────────────

    /// @notice Arena funds a spot pool by depositing into it. Here the collateral
    ///         has already been placed by `fund`, so this only re-sweeps — it
    ///         exists so Arena's funding path works unchanged against a desk.
    ///         The token argument is ignored: on testnet the desk's collateral is
    ///         tUSDC, not the USDso Arena names. See the testnet note above.
    function deposit(address, uint256) external override bound {
        _sweep();
    }

    /// @notice Pull collateral back out of the vault, to the owner (the treasury
    ///         on testnet), so an idle desk's balance is never stranded.
    function withdraw(address, uint256 amount) external override onlyOwner bound {
        uint256 amount6 = amount / scale;
        pool.withdraw(collateral, amount6);
        IERC20Like(collateral).transfer(owner, amount6);
    }

    function depositNative() external payable override { revert Unsupported(); }

    function getWithdrawableBalance(address user, address) external view override returns (uint256) {
        // Arena asks about its own balance; the vault position is held by the desk.
        address who = user == arena ? address(this) : user;
        return pool.getWithdrawableBalance(who, collateral) * scale;
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
            // Price so a holding can still be valued, but ZERO size, because a
            // resolved market accepts no orders. It used to report unlimited
            // size, which made a settled question look tradable: a fighter was
            // offered it, its order reverted, and the turn was lost. Whoever
            // reads this must decide tradability on size, not on price alone.
            one[0] = OrderBookLevel({ price: settled, quantity: 0 });
            return one;
        }

        OrderBookLevel[] memory raw = pool.getBookLevels(isBid, numLevels);
        if (raw.length > 0) {
            OrderBookLevel[] memory out = new OrderBookLevel[](raw.length);
            for (uint256 i = 0; i < raw.length; i++) {
                out[i] = OrderBookLevel({ price: raw[i].price * scale, quantity: raw[i].quantity * scale });
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
            stale[0] = OrderBookLevel({ price: cached * scale, quantity: 0 });
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
            g.tickSize   * scale,
            g.minQuantity * scale,
            g.lotSize    * scale
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
            price / scale,
            quantity / scale,
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
        return outcomeToken.balanceOf(address(this), yesId) * scale;
    }
}
