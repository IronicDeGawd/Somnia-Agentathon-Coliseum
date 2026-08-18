// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/ISpotPool.sol";
import "./interfaces/IPerps.sol";
import "./interfaces/IERC20Minimal.sol";

/// @title  PerpDesk
/// @notice Makes one dreamDEX perpetual market look like an ordinary Coliseum spot
///         pool, so Arena can trade leveraged futures without knowing what one is.
///
/// Same job `EventDesk` does for prediction windows, and a much smaller job, because
/// two of that adapter's three reasons for existing are gone here:
///
///   - EXPIRY PASSES STRAIGHT THROUGH. A binary pool caps order expiry at the
///     market's own, so Arena's hard-coded +3600s had to be replaced or every trade
///     reverted. A perp market never expires and imposes no cap.
///   - THE ADDRESS NEVER MOVES. Prediction windows open at a fresh address every few
///     minutes, which is why an event desk is re-bound constantly and why a whole
///     rebinding cron exists. Six perp markets were deployed once and stay. So a
///     desk is bound to its market at construction, `immutable`, and there is no
///     re-point path to get wrong.
///
/// What DOES have to be translated:
///
///  1. THERE IS NO VAULT. A spot pool holds your tokens; a perp pool holds nothing
///     and settles against a shared `MarginBank` keyed on the trading address. So a
///     desk owns no funds and routes every order to the calling fighter's own
///     account, reached through the registry.
///
///  2. ARENA SPEAKS IN SLOTS, THE PROTOCOL IN ADDRESSES. Arena's three market slots
///     must be three distinct addresses, but a fighter must hold ONE margin pot
///     across all three. The fighter's identity therefore rides on `userData` — an
///     otherwise unused pass-through field on the order, which Arena hard-coded to
///     zero until now — and all six desks converge on one account per fighter.
///
///  3. A HOLDING IS NOT A BALANCE. "Do you hold any WETH" has no answer here: a
///     position is signed, can be negative, and is worth whatever the mark says. So
///     the questions Arena needs answered about a fighter are asked directly
///     (`fighterTradability`, `fighterSide`) instead of being read off a token
///     balance.
///
/// SCALE. Nothing is rescaled. The perp pool quotes prices in quote-token units —
/// the same 18-decimal USDso Coliseum thinks in — and sizes in its own base units,
/// which is exactly the `baseUnit` convention Arena's order maths already uses. The
/// unit is still read from the market itself (`getOneBase`) and exposed rather than
/// assumed, because assuming it is the specific mistake `EventDesk` shipped with and
/// had to be redeployed to fix.
contract PerpDesk is ISpotPool {

    address public immutable arena;

    /// @notice The perp market this desk fronts. Set once; there is nothing that
    ///         expires and therefore nothing to re-point.
    address public immutable market;

    /// @notice Where fighter accounts are leased and orders are routed.
    IPerpRegistry public immutable registry;

    /// @notice The collateral every account posts, and the token Arena calls quote.
    address public immutable collateral;

    error NotArena();
    error Unsupported();

    /// @notice Last non-empty top-of-book seen. Refreshed by `poke()` and by every
    ///         order, and used to value a position while the book is momentarily
    ///         empty but the market is very much alive.
    uint256 public lastGoodBid;
    uint256 public lastGoodAsk;

    event BookCached(uint256 bid, uint256 ask);
    event OrderRouted(uint256 indexed duelId, uint8 indexed fighterId, bool isBid, uint256 price, uint256 quantity, bool ok);

    modifier onlyArena() { if (msg.sender != arena) revert NotArena(); _; }

    constructor(address arena_, address market_, address registry_, address collateral_) {
        // No `owner`: a desk holds no funds and has no owner-only function, so an
        // owner slot here would only suggest an authority that does not exist.
        arena      = arena_;
        market     = market_;
        registry   = IPerpRegistry(registry_);
        collateral = collateral_;
    }

    // ─── ISpotPool: the face Arena sees ───────────────────────────────────────

    /// @notice Arena's order, routed to whichever fighter's account `userData` names.
    ///
    ///         `orderType` is accepted and discarded. Arena asks for fill-or-kill;
    ///         the registry sends immediate-or-cancel. That is not a downgrade: a
    ///         perp fill-or-kill does not revert on a thin book, it returns
    ///         `(false, 0)` and the turn is wasted, whereas immediate-or-cancel
    ///         KEEPS the part that filled. Neither rests in the book, which is what
    ///         keeps every position ours to close and liquidation cheap.
    function placeOrder(
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   /* orderType — see above */,
        uint8   /* selfMatchingOption */,
        address /* builder */,
        uint96  /* builderFeeBpsTimes1k */
    ) external override onlyArena returns (bool success, uint128 orderId) {
        // Remember the book we are about to trade into, so a blackout starting after
        // this turn still has a recent price behind it.
        _cacheBook();

        (uint256 duelId, uint8 fighterId) = _decode(userData);
        (success, orderId) = registry.trade(duelId, fighterId, isBid, price, quantity, expireTimestampNs);
        emit OrderRouted(duelId, fighterId, isBid, price, quantity, success);
    }

    /// @dev The fighter's identity as Arena packs it: the duel in the high bits, the
    ///      registry fighter index in the low byte. A zero here is not a valid
    ///      fighter, and the registry answers `(false, 0)` rather than guessing.
    function _decode(uint64 userData) internal pure returns (uint256 duelId, uint8 fighterId) {
        duelId    = uint256(userData) >> 8;
        fighterId = uint8(userData & 0xff);
    }

    /// @notice Top of book, or the mark with ZERO size while the book is empty.
    ///
    ///         The zero is the load-bearing part, and the same trick `EventDesk`
    ///         uses. A price with no size lets a position still be valued while
    ///         Arena's own `quantity == 0` check refuses to send an order into a
    ///         book with nothing in it. Reporting size that is not there got a
    ///         fighter's order rejected and its turn lost.
    function getBookLevels(bool isBid, uint64 numLevels)
        external view override returns (OrderBookLevel[] memory)
    {
        OrderBookLevel[] memory raw;
        try IPerpPool(market).getBookLevels(isBid, numLevels) returns (OrderBookLevel[] memory l) {
            raw = l;
        } catch {}
        if (raw.length > 0 && raw[0].quantity > 0) return raw;

        // Empty book. Unlike a prediction window this market has not settled and is
        // not going to — a perp has no expiry — so the position is still worth
        // roughly the mark. Prefer the oracle over the cached book: it is the same
        // number the protocol itself will value the position at.
        uint256 fallbackPrice;
        try IPerpPool(market).tryGetMarkPrice() returns (bool ok, uint256 mark) {
            if (ok) fallbackPrice = mark;
        } catch {}
        if (fallbackPrice == 0) fallbackPrice = isBid ? lastGoodBid : lastGoodAsk;
        if (fallbackPrice == 0) return raw;

        OrderBookLevel[] memory one = new OrderBookLevel[](1);
        one[0] = OrderBookLevel({ price: fallbackPrice, quantity: 0 });
        return one;
    }

    /// @notice Refresh the cached top-of-book. Permissionless and cheap; the keeper
    ///         calls it each turn so a blackout starting mid-duel is still backed by
    ///         a recent price rather than a stale one.
    function poke() external { _cacheBook(); }

    function _cacheBook() internal {
        uint256 bid;
        uint256 ask;
        try IPerpPool(market).getBookLevels(true, 1) returns (OrderBookLevel[] memory b) {
            if (b.length > 0) bid = b[0].price;
        } catch {}
        try IPerpPool(market).getBookLevels(false, 1) returns (OrderBookLevel[] memory a) {
            if (a.length > 0) ask = a[0].price;
        } catch {}
        if (bid == 0 && ask == 0) return;
        if (bid > 0) lastGoodBid = bid;
        if (ask > 0) lastGoodAsk = ask;
        emit BookCached(lastGoodBid, lastGoodAsk);
    }

    /// @notice The 7-tuple Arena caches its order maths from, assembled out of the
    ///         two calls a perp market answers instead.
    /// @dev    `baseToken` is the zero address because a perp's base asset is
    ///         synthetic — there is no token to name. Nothing in Arena calls a
    ///         method on it; the SOMI book already ships a base "token" with no code
    ///         for the same reason, which is why `baseDecimals` is supplied to
    ///         `_cachePoolMeta` by the caller rather than read on chain.
    function getPoolParams() external view override returns (
        address, address, uint256, uint256, uint256, uint256, uint256
    ) {
        uint256 tick;
        uint256 minQty;
        uint256 lot;
        try IPerpPool(market).getOrderBookParameters() returns (uint256 t, uint256 m, uint256 l) {
            tick = t; minQty = m; lot = l;
        } catch {}
        // Fees are zero on all six markets (`takerFeeBpsTimes1k: 0`), and are read
        // by nothing in Arena's order path — reported as zero rather than invented.
        return (address(0), collateral, 0, 0, tick, minQty, lot);
    }

    /// @notice 10^decimals of the synthetic base asset. Read by the deploy script to
    ///         derive the `baseDecimals` it registers with Arena, so that figure
    ///         comes from the market and never from a table somebody maintains.
    function oneBase() external view returns (uint256) {
        try IPerpPool(market).getOneBase() returns (uint256 ob) { return ob; } catch { return 0; }
    }

    /// @notice Unlent collateral behind the fighters this desk serves.
    /// @dev    Arena's spot path reads this to ask "is there quote left in the vault
    ///         to draw on". The honest analogue for perps is the registry's float,
    ///         which is what actually funds the next fighter. The per-fighter
    ///         question — can THIS fighter afford a position — has no answer without
    ///         a duel and a fighter, and is asked through `fighterTradability`.
    function getWithdrawableBalance(address, address) external view override returns (uint256) {
        return IERC20Minimal(collateral).balanceOf(address(registry));
    }

    /// @notice Deliberately unsupported, both ways. A perp market has no vault: there
    ///         is nothing to deposit into and nothing to withdraw from, and the
    ///         collateral a fighter posts lives in the shared `MarginBank` against
    ///         that fighter's own address.
    ///
    ///         Arena's float is funded and recovered through `fundPerpFloat` and
    ///         `withdrawPerpFloat` instead. Routing it through a desk as well would
    ///         mean a second address authorised to move the float, for no gain —
    ///         and failing loudly here means a funding script pointed at a desk by
    ///         mistake stops rather than leaving tokens stranded in this contract.
    function withdraw(address, uint256) external pure override { revert Unsupported(); }

    function deposit(address, uint256) external pure override { revert Unsupported(); }

    function depositNative() external payable override { revert Unsupported(); }

    /// @notice Unsupported, and unreachable: every fighter order is
    ///         immediate-or-cancel, so nothing ever rests to be cancelled.
    function cancelOrder(uint128) external pure override { revert Unsupported(); }

    // ─── What Arena asks about a fighter ──────────────────────────────────────

    /// @notice May this fighter go long, and may it go short, on this market now?
    ///         Replaces the base-token balance check a spot slot uses, and is the
    ///         single change that lets a fighter sell what it does not own.
    function fighterTradability(uint256 duelId, uint8 fighterId)
        external view returns (bool canLong, bool canShort)
    {
        try IPerpRegistryReads(address(registry)).tradability(market, duelId, fighterId)
            returns (bool l, bool s) { return (l, s); }
        catch { return (false, false); }
    }

    /// @return side -1 short, 0 flat, 1 long.
    function fighterSide(uint256 duelId, uint8 fighterId) external view returns (int8 side) {
        try IPerpRegistryReads(address(registry)).sideOf(market, duelId, fighterId)
            returns (int8 s) { return s; }
        catch { return 0; }
    }
}

/// @dev The two per-fighter reads, split out so `IPerpRegistry` stays the narrow
///      slice ARENA calls and this stays the narrow slice a DESK calls.
interface IPerpRegistryReads {
    function tradability(address market, uint256 duelId, uint8 fighterId)
        external view returns (bool canLong, bool canShort);
    function sideOf(address market, uint256 duelId, uint8 fighterId) external view returns (int8);
}
