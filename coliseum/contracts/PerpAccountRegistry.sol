// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IPerps.sol";
import "./interfaces/IERC20Minimal.sol";
import "./PerpAccount.sol";

/// @title  PerpAccountRegistry
/// @notice Hands each fighter its own trading address for the length of a duel,
///         decides which markets a budget can actually afford, and cleans up
///         afterwards.
///
/// THE SHAPE, AND WHY. A fight has three market slots, so Arena needs three
/// distinct pool addresses per duel — but a fighter must hold ONE margin pot, not
/// three, because pooling its own positions is how a trader actually works and
/// because splitting them would triple the collateral needed to cover the same
/// budget. Those two facts pull in opposite directions. This contract is the joint:
/// six permanent desks all route here, and here they converge on one account per
/// (duel, fighter). Two accounts a fight, not six.
///
/// Isolation BETWEEN fighters is preserved because they remain separate addresses,
/// which is the only thing that actually isolates cross margin. Cross margin WITHIN
/// a fighter is deliberate.
///
/// WHY AFFORDABILITY IS COMPUTED AND NOT CONFIGURED. An earlier design named the
/// three markets in advance and sized the entry price from the configured margin
/// factor. Measured live, Bitcoin's EFFECTIVE factor was 3.7x its configured one,
/// because the protocol scales it up with open interest — which made Bitcoin 90% of
/// a fight's margin and would have shipped as a mispriced tier that somebody had to
/// notice. Asking the markets what they cost, at the moment the fight starts, turns
/// that from a bug into Bitcoin quietly dropping out of the cheap tiers and walking
/// back in when the factor relaxes.
///
/// Money never rests in a fighter's account between duels: it is reclaimed to this
/// contract's float and lent out again on the next lease.
contract PerpAccountRegistry {

    /// @dev The protocol's `ImmediateOrCancel`. Chosen over `FillOrKill` because IOC
    ///      KEEPS a partial fill where FOK discards it, so a fighter facing thin
    ///      top-of-book gets a smaller position rather than a wasted turn. Neither
    ///      one rests in the book, which is what keeps liquidation cheap for us and
    ///      means no cancel path is ever needed.
    uint8 private constant ORDER_TYPE_IOC = 2;

    /// @dev How many book levels a flatten is allowed to sweep through. One level
    ///      often is not the whole position, and a position left open is the one
    ///      outcome that costs real money (a quarantined account).
    uint64 private constant FLATTEN_DEPTH = 5;

    uint256 private constant BPS = 10_000;

    address public immutable owner;
    address public immutable arena;
    IERC20Minimal public immutable collateral;
    IMarginBank  public immutable bank;

    /// @notice The six permanent desks, and the market each one fronts. Set once by
    ///         the owner. Desks are the addresses ARENA sees; markets are the
    ///         addresses the protocol sees.
    address[] public desks;
    mapping(address => address) public marketOfDesk;
    /// @notice The reverse direction, kept only so a second desk on the same market
    ///         can be refused at registration.
    mapping(address => address) public marketOf;
    mapping(address => bool)    public isDesk;

    /// @notice duelId → fighterId → the account leased to it, or zero.
    mapping(uint256 => mapping(uint8 => address)) public accounts;

    /// @notice EVERY child ever created, in creation order.
    ///
    ///         Kept because the alternative is that they cannot be found. An account is
    ///         a contract holding real collateral, and without a list the only way to
    ///         enumerate them is to trace contract creations off-chain — so the
    ///         balance audit that exists for every other market here
    ///         (`audit-balances.ts`, `check-arena-vaults.ts`) had no perps equivalent
    ///         it could even be written against.
    address[] internal allAccounts;

    /// @notice Children not currently leased to anyone, ready to be handed out.
    address[] internal freeList;

    /// @notice Every account ever quarantined, in order, so stuck collateral can be
    ///         found without replaying logs. Entries are NOT removed when an account
    ///         is restored — `quarantined[a]` is the live flag, this is the history.
    address[] internal quarantineHistory;

    /// @notice account -> the fight it was leased to, packed `duelId << 8 | fighterId`,
    ///         or zero once released cleanly.
    ///
    ///         The reverse of `accounts`, and it exists for the operator: every rescue
    ///         path is keyed on (duelId, fighterId), but what an audit actually finds is
    ///         an ADDRESS holding money. Without this, working out which fight a stuck
    ///         account belonged to means grinding through `Leased` events.
    mapping(address => uint256) public leaseTag;

    /// @notice Leased right now. Guards against one account serving two fighters,
    ///         which would silently re-create the shared-margin bug this whole
    ///         contract exists to avoid.
    mapping(address => bool) public inUse;

    /// @notice An account that could not be cleaned up. NEVER re-leased while the flag
    ///         is set: it may still carry a position, and handing it to a new fighter
    ///         would give that fighter somebody else's exposure.
    ///
    ///         The collateral inside is not lost, and there are now three ways to get
    ///         it: `retryRelease` keeps trying the automatic close; `forceClose` lets
    ///         the owner pick a price aggressive enough to actually clear; and
    ///         `rescueAccount` takes back whatever the bank will release even if the
    ///         position never closes. An earlier version of this comment claimed the
    ///         owner could drain an account by hand when NO such function existed —
    ///         which is the only reason the flag ever looked safe.
    mapping(address => bool) public quarantined;

    /// @notice Set while a release is in flight.
    ///
    ///         Winding down makes external calls to the market and the bank BEFORE it
    ///         updates its own bookkeeping, which is unavoidable: whether an account
    ///         ended flat is only knowable after trying to close it. The callees are
    ///         protocol contracts today, so there is no reachable re-entry — but the
    ///         failure mode if there ever were is an account pushed onto the free list
    ///         twice, and two fighters sharing one margin pool is the exact thing this
    ///         contract exists to prevent. Cheap guard, expensive bug.
    bool internal releasing;

    error NotOwner();
    error NotArena();
    error NotDesk();
    error DesksAlreadySet();
    error NoDesks();
    error InvalidDesk(address desk);
    error AlreadyLeased();
    error ZeroAmount();
    error FloatTooSmall(uint256 have, uint256 want);
    error NotEnoughMarkets(uint256 found);
    error NotQuarantined();
    error TransferFailed();
    error Reentrant();
    error DuplicateMarket(address market);
    error DeskNotBoundHere(address desk);
    error CannotSweepCollateral();

    event DesksRegistered(address[] desks);
    event AccountsAdded(uint256 count, uint256 free);
    event AccountCreated(address indexed account);
    event FloatFunded(uint256 amount, uint256 balance);
    event FloatReleased(address indexed to, uint256 amount);
    event Leased(uint256 indexed duelId, uint8 indexed fighterId, address indexed account, uint256 budget);
    event Released(uint256 indexed duelId, uint8 indexed fighterId, address indexed account, uint256 reclaimed, bool clean);
    event Quarantined(address indexed account, string reason);
    event FlattenFailed(address indexed account, address indexed market, int128 sizeLeft);
    event ForceClosed(address indexed account, address indexed market, bool isBid, uint256 price, uint256 quantity, bool ok);
    event Rescued(address indexed account, uint256 reclaimed);
    event StraySwept(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() {
        if (releasing) revert Reentrant();
        releasing = true;
        _;
        releasing = false;
    }
    modifier onlyArena() { if (msg.sender != arena) revert NotArena(); _; }

    constructor(address collateral_, address bank_, address arena_) {
        owner      = msg.sender;
        arena      = arena_;
        collateral = IERC20Minimal(collateral_);
        bank       = IMarginBank(bank_);
    }

    // ─── Wiring ───────────────────────────────────────────────────────────────

    /// @notice Register the permanent desks. One-shot: the desks front markets that
    ///         never expire, so unlike an event window there is no reason to ever
    ///         re-point them, and making it impossible removes a way to break a
    ///         running fight.
    function registerDesks(address[] calldata desks_) external onlyOwner {
        if (desks.length != 0) revert DesksAlreadySet();
        if (desks_.length == 0) revert NoDesks();
        for (uint256 i = 0; i < desks_.length; i++) {
            address d = desks_[i];
            address m = IPerpDesk(d).market();
            if (m == address(0)) revert InvalidDesk(d);

            // A desk routes its orders to whichever registry it was built against, and
            // that pointer is immutable. Registering one built against a DIFFERENT
            // registry would make Arena trade through an address whose accounts and
            // float live somewhere else — every order refused, for a reason visible
            // nowhere.
            if (IPerpDesk(d).registry() != address(this)) revert DeskNotBoundHere(d);

            // TWO DESKS ON ONE MARKET IS SILENTLY BROKEN, which is why it is refused
            // rather than tolerated. Both would carry the same label, so the action
            // vocabulary would offer the same name twice; the reply matcher takes the
            // FIRST match, so one of the two slots becomes permanently unreachable.
            // Worse, a fighter's two slots would be the same position, and it could
            // trade against itself.
            if (marketOf[m] != address(0)) revert DuplicateMarket(m);

            desks.push(d);
            marketOfDesk[d] = m;
            marketOf[m] = d;
            isDesk[d] = true;
        }
        emit DesksRegistered(desks_);
    }

    /// @notice Pre-deploy `n` children so leasing one costs a mapping write rather
    ///         than a contract deployment inside `startDuel`.
    function addAccounts(uint256 n) external onlyOwner {
        for (uint256 i = 0; i < n; i++) {
            address a = address(new PerpAccount(address(collateral), address(bank)));
            allAccounts.push(a);
            freeList.push(a);
            // One event per account, carrying the ADDRESS. The count alone was useless:
            // it told an operator that eight contracts holding collateral now existed
            // somewhere, and nothing about where.
            emit AccountCreated(a);
        }
        emit AccountsAdded(n, freeList.length);
    }

    function freeCount() external view returns (uint256) { return freeList.length; }

    function deskCount() external view returns (uint256) { return desks.length; }

    // ─── The float ────────────────────────────────────────────────────────────

    /// @notice Move collateral in, to be lent to fighters. Callable by the owner or
    ///         by Arena, because Arena's own funding path routes here.
    function fundFloat(uint256 amount) external {
        if (msg.sender != owner && msg.sender != arena) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        if (!collateral.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit FloatFunded(amount, collateral.balanceOf(address(this)));
    }

    /// @notice Take unlent collateral back out.
    function releaseFloat(uint256 amount, address to) external {
        if (msg.sender != owner && msg.sender != arena) revert NotOwner();
        if (amount == 0) revert ZeroAmount();
        uint256 have = collateral.balanceOf(address(this));
        if (have < amount) revert FloatTooSmall(have, amount);
        if (!collateral.transfer(to, amount)) revert TransferFailed();
        emit FloatReleased(to, amount);
    }

    /// @notice Collateral sitting here, lent to nobody.
    function floatBalance() external view returns (uint256) {
        return collateral.balanceOf(address(this));
    }

    // ─── Market selection ─────────────────────────────────────────────────────

    /// @notice The three markets a fight with this budget should be offered.
    ///
    ///         Deliberately a view, and deliberately OUTSIDE the duel-start path's
    ///         critical section: six markets with several oracle-dependent reads
    ///         each, any one of which can fail on a stale feed, has no business
    ///         being inline in the most safety-critical function in the system. A
    ///         market that cannot answer is skipped; it is never fatal.
    ///
    /// @param budget  collateral one fighter will be given, in 18-decimal USDso.
    /// @param salt    rotates the pick when more than three markets qualify, so
    ///                consecutive fights at one tier are not the same fight. Arena
    ///                passes the duel id.
    function selectMarkets(uint256 budget, uint256 salt) external view returns (address[3] memory picked) {
        uint256 n = desks.length;
        address[] memory ok = new address[](n);
        uint256 m = 0;
        for (uint256 i = 0; i < n; i++) {
            if (_qualifies(marketOfDesk[desks[i]], budget)) ok[m++] = desks[i];
        }
        if (m < 3) revert NotEnoughMarkets(m);
        for (uint256 i = 0; i < 3; i++) picked[i] = ok[(salt + i) % m];
    }

    /// @notice What one smallest position in `market` costs in margin right now, and
    ///         whether the market can be traded at all. Exposed because the tier
    ///         ladder is only checkable against live numbers.
    /// @return tradable false when the market cannot be priced, is close-only, or
    ///         has no two-sided book to trade against.
    /// @return imPerLot initial margin for one minimum-size position, 18 decimals.
    function marketCost(address market) public view returns (bool tradable, uint256 imPerLot) {
        // Order matters: `getEffectiveIMF` hard-reverts on a stale index feed, and
        // `isPriceable` applies exactly the gates that make it safe. Probing first
        // is what turns a revert into a skip.
        try IPerpPool(market).isPriceable() returns (bool ok) {
            if (!ok) return (false, 0);
        } catch { return (false, 0); }

        try IPerpPool(market).isRestricted() returns (bool restricted) {
            if (restricted) return (false, 0);
        } catch { return (false, 0); }

        (bool markOk, uint256 mark) = _tryMark(market);
        if (!markOk || mark == 0) return (false, 0);

        uint256 minQty;
        uint256 oneBase;
        try IPerpPool(market).getOrderBookParameters() returns (uint256, uint256 mq, uint256) {
            minQty = mq;
        } catch { return (false, 0); }
        try IPerpPool(market).getOneBase() returns (uint256 ob) {
            oneBase = ob;
        } catch { return (false, 0); }
        if (minQty == 0 || oneBase == 0) return (false, 0);

        uint256 imf;
        try IPerpPool(market).getEffectiveIMF() returns (uint256 f) {
            imf = f;
        } catch { return (false, 0); }
        if (imf == 0) return (false, 0);

        // Notional first, then the factor. The other order overflows nothing here
        // but loses precision on the small markets.
        uint256 notional = (minQty * mark) / oneBase;
        imPerLot = (notional * imf) / BPS;
        if (imPerLot == 0) return (false, 0);

        // A one-sided book offers one direction only, and a fighter handed a move it
        // cannot execute loses its turn to a reverted order.
        if (!_hasSize(market, true) || !_hasSize(market, false)) return (false, 0);
        tradable = true;
    }

    function _qualifies(address market, uint256 budget) internal view returns (bool) {
        (bool tradable, uint256 imPerLot) = marketCost(market);
        return tradable && imPerLot <= budget;
    }

    // ─── Leasing ──────────────────────────────────────────────────────────────

    /// @notice Give this fighter an address of its own and fund it with `budget`.
    /// @dev    Deploys a child if none is spare. That costs gas inside `startDuel`,
    ///         which is why `addAccounts` exists — but a lobby that cannot start a
    ///         fight because a free list ran dry is worse than an expensive start.
    function lease(uint256 duelId, uint8 fighterId, uint256 budget)
        external onlyArena returns (address account)
    {
        if (accounts[duelId][fighterId] != address(0)) revert AlreadyLeased();
        if (budget == 0) revert ZeroAmount();

        uint256 have = collateral.balanceOf(address(this));
        if (have < budget) revert FloatTooSmall(have, budget);

        account = _takeFree();
        accounts[duelId][fighterId] = account;
        leaseTag[account] = _userData(duelId, fighterId);
        inUse[account] = true;

        if (!collateral.transfer(account, budget)) revert TransferFailed();
        PerpAccount(account).fund(budget);

        emit Leased(duelId, fighterId, account, budget);
    }

    function _takeFree() internal returns (address account) {
        uint256 n = freeList.length;
        while (n > 0) {
            account = freeList[n - 1];
            freeList.pop();
            n--;
            // A quarantined child can reach the free list only through a bug, but
            // handing one out would give a fighter somebody else's exposure, so it
            // is checked rather than assumed.
            if (!quarantined[account] && !inUse[account]) return account;
        }
        account = address(new PerpAccount(address(collateral), address(bank)));
        allAccounts.push(account);
        emit AccountCreated(account);
        return account;
    }

    // ─── Trading ──────────────────────────────────────────────────────────────

    /// @notice Place one order for a fighter. Only a registered desk may ask, and
    ///         the market is the desk's own — a desk cannot trade a market it does
    ///         not front, so a mis-wired desk cannot reach across the board.
    function trade(
        uint256 duelId,
        uint8   fighterId,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs
    ) external returns (bool ok, uint128 orderId) {
        if (!isDesk[msg.sender]) revert NotDesk();
        address account = accounts[duelId][fighterId];
        if (account == address(0)) return (false, 0);
        return PerpAccount(account).trade(
            marketOfDesk[msg.sender],
            isBid,
            _userData(duelId, fighterId),
            price,
            quantity,
            expireTimestampNs,
            ORDER_TYPE_IOC
        );
    }

    /// @dev The fill's identity, carried on the order through the protocol's own
    ///      pass-through field so a trade in the log can be attributed to a fighter
    ///      without matching on block and address.
    function _userData(uint256 duelId, uint8 fighterId) internal pure returns (uint64) {
        return uint64((duelId << 8) | uint256(fighterId));
    }

    // ─── Winding down ─────────────────────────────────────────────────────────

    /// @notice Flatten this fighter's positions and take the collateral back.
    ///
    ///         BEST-EFFORT BY CONSTRUCTION, and the caller must keep it that way. A
    ///         revert on this path would freeze the duel it belongs to, and a frozen
    ///         duel means the players cannot recover their stake — far worse than
    ///         seed collateral sitting in a quarantined child until someone retries.
    ///
    /// @return reclaimed collateral that made it back to the float.
    /// @return clean     true when the account ended flat and was returned to
    ///                   circulation; false when it was quarantined.
    function release(uint256 duelId, uint8 fighterId)
        external onlyArena returns (uint256 reclaimed, bool clean)
    {
        return _release(duelId, fighterId);
    }

    /// @notice Try a failed cleanup again.
    ///
    ///         RESTRICTED TO A QUARANTINED ACCOUNT, and that restriction is the whole
    ///         security of this function. It was permissionless and ungated on the
    ///         reasoning that it "can only move a stuck position toward flat" — which
    ///         is false, because nothing here knew whether the fight was over. Anyone
    ///         could call it on a LIVE duel and close a fighter's winning position,
    ///         take its collateral back into the float, and clear its lease; the
    ///         fighter would then be offered nothing but Hold for the rest of the
    ///         fight and score off a stale snapshot. Directly profitable to anyone
    ///         betting on the other side.
    ///
    ///         A quarantined account is by definition one Arena has already finished
    ///         with and failed to clean, so it cannot belong to a running fight.
    ///
    ///         The owner and Arena may still call it regardless, as the break-glass
    ///         for the one case quarantine cannot describe: `_release` itself
    ///         reverting outright, which leaves the account leased and unflagged.
    function retryRelease(uint256 duelId, uint8 fighterId)
        external returns (uint256 reclaimed, bool clean)
    {
        address account = accounts[duelId][fighterId];
        if (!quarantined[account] && msg.sender != owner && msg.sender != arena)
            revert NotQuarantined();
        return _release(duelId, fighterId);
    }

    function _release(uint256 duelId, uint8 fighterId) internal nonReentrant returns (uint256 reclaimed, bool clean) {
        address account = accounts[duelId][fighterId];
        if (account == address(0)) return (0, true);

        clean = _flatten(account);

        // Only what the bank will actually release. Asking for more than that makes
        // the withdrawal revert as a whole, which would strand the recoverable part
        // along with the rest.
        uint256 free = 0;
        try bank.getWithdrawableCollateral(account) returns (uint256 w) { free = w; } catch {}

        // With a position still open that figure is a lie — `getWithdrawableCollateral`
        // reports unlocked collateral and IGNORES the margin the position needs, which
        // is why it must not be trusted on its own. Capping by real free margin here is
        // what recovers MOST of a stuck account's collateral instead of none of it:
        // asking for the full amount would be refused outright and leave the whole
        // budget sitting in a quarantined child.
        if (!clean) {
            uint256 usable = freeMarginOf(account);
            if (usable < free) free = usable;
        }
        if (free > 0) reclaimed = PerpAccount(account).reclaim(free);
        reclaimed += PerpAccount(account).sweep();

        if (clean) {
            // Clearing the quarantine matters on a RETRY: the first attempt set it,
            // and leaving it set would drain the account and then still refuse to
            // reuse it, quietly shrinking the pool one stuck fight at a time.
            quarantined[account] = false;
            inUse[account] = false;
            accounts[duelId][fighterId] = address(0);
            leaseTag[account] = 0;
            freeList.push(account);
        } else {
            if (!quarantined[account]) quarantineHistory.push(account);
            quarantined[account] = true;
            emit Quarantined(account, "position not flat");
        }
        emit Released(duelId, fighterId, account, reclaimed, clean);
    }

    /// @dev Close every position the account holds, one market at a time. Returns
    ///      false if anything is still open afterwards.
    ///
    ///      Sweeps several book levels deep rather than taking only top-of-book: a
    ///      position is usually more than one level wide, and a partial close is the
    ///      one outcome that actually costs money. An immediate-or-cancel order
    ///      priced through the book fills what is there at each level's own price
    ///      and discards the rest, so crossing deep is not the same as paying the
    ///      deep price on the whole size.
    function _flatten(address account) internal returns (bool clean) {
        address[] memory open;
        try bank.getActivePerpPools(account) returns (address[] memory p) {
            open = p;
        } catch { return false; }

        clean = true;
        for (uint256 i = 0; i < open.length; i++) {
            if (!_closeOne(account, open[i])) clean = false;
        }
    }

    function _closeOne(address account, address market) internal returns (bool) {
        int128 size = _sizeOf(account, market);
        if (size == 0) return true;

        // Closing a short means buying, so it needs the ASK side; closing a long
        // needs the bids. Same relationship Arena uses when it reads `!isBid`.
        bool isBid = size < 0;
        uint256 quantity = uint256(uint128(size < 0 ? -size : size));

        OrderBookLevel[] memory levels;
        try IPerpPool(market).getBookLevels(!isBid, FLATTEN_DEPTH) returns (OrderBookLevel[] memory l) {
            levels = l;
        } catch {
            emit FlattenFailed(account, market, size);
            return false;
        }
        if (levels.length == 0) {
            emit FlattenFailed(account, market, size);
            return false;
        }

        // The deepest level we can see. Crossing to it lets the order consume every
        // level above on the way through.
        uint256 price = levels[levels.length - 1].price;
        price = _alignPrice(market, price, isBid);
        if (price == 0) {
            emit FlattenFailed(account, market, size);
            return false;
        }

        PerpAccount(account).trade(
            market, isBid, 0, price, quantity,
            uint64(block.timestamp + 3600) * 1_000_000_000,
            ORDER_TYPE_IOC
        );

        int128 left = _sizeOf(account, market);
        if (left != 0) {
            emit FlattenFailed(account, market, left);
            return false;
        }
        return true;
    }

    function _alignPrice(address market, uint256 price, bool isBid) internal view returns (uint256) {
        uint256 tick;
        try IPerpPool(market).getOrderBookParameters() returns (uint256 t, uint256, uint256) {
            tick = t;
        } catch { return 0; }
        if (tick == 0) return price;
        // A buy rounds UP and a sell rounds DOWN, so alignment never moves the
        // price to the wrong side of the level it was meant to reach.
        return isBid ? ((price + tick - 1) / tick) * tick : (price / tick) * tick;
    }

    // ─── Owner rescue ─────────────────────────────────────────────────────────
    //
    // The automatic wind-down closes a position by sweeping five levels of the book.
    // That covers the ordinary case and nothing else. When a book does not come back,
    // or a market stays close-only, the collateral behind a stuck position had NO way
    // out at all — the account answers only to this contract, and this contract only
    // ever attempted the automatic close. These three functions are that missing exit.
    //
    // The normal recovery sequence, once a market is tradable again:
    //   1. `forceClose(...)` at a price aggressive enough to actually clear
    //   2. `retryRelease(duelId, fighterId)` — flattens, drains, un-quarantines, and
    //      returns the account to circulation
    // And when a position can never be closed, `rescueAccount` takes back whatever the
    // bank will still release, which is the write-off path rather than a total loss.

    /// @notice Place one order for a stuck account, at a price the owner chooses.
    ///
    ///         The single thing the automatic path cannot do: pick the price. A
    ///         position wider than the visible book needs to cross further than five
    ///         levels, and only a human looking at the market knows how far.
    ///
    ///         Deliberately not restricted to reducing orders — a rescue sometimes
    ///         means hedging into the other direction to stop the bleeding while a
    ///         book recovers. It is owner-only, and it can only ever trade an account
    ///         this registry owns, so the authority it grants is over the house's own
    ///         collateral and nothing else.
    function forceClose(
        address account,
        address market,
        bool    isBid,
        uint256 price,
        uint256 quantity
    ) external onlyOwner returns (bool ok, uint128 orderId) {
        (ok, orderId) = PerpAccount(account).trade(
            // Carry the fight's identity if the account still has one, so a rescue
            // fill is attributable in the log like any other.
            market, isBid, uint64(leaseTag[account]),
            price, quantity,
            uint64(block.timestamp + 3600) * 1_000_000_000,
            ORDER_TYPE_IOC
        );
        emit ForceClosed(account, market, isBid, price, quantity, ok);
    }

    /// @notice Take back whatever collateral the bank will release from an account,
    ///         without requiring it to be flat first.
    ///
    ///         Capped by real free margin, never by `getWithdrawableCollateral` — that
    ///         read ignores the margin an open position still needs, so asking for the
    ///         figure it reports would be refused outright and recover NOTHING.
    /// @return reclaimed how much reached the float.
    function rescueAccount(address account) external onlyOwner returns (uint256 reclaimed) {
        uint256 want = 0;
        try bank.getWithdrawableCollateral(account) returns (uint256 w) { want = w; } catch {}
        uint256 usable = freeMarginOf(account);
        if (usable < want) want = usable;
        if (want > 0) reclaimed = PerpAccount(account).reclaim(want);
        reclaimed += PerpAccount(account).sweep();
        emit Rescued(account, reclaimed);
    }

    /// @notice Pull a stray token out of an account and then out of this contract.
    ///
    ///         An account is a plain address, so anything can be sent to one. Without
    ///         this the only balance that could ever leave a retired account is the
    ///         collateral.
    /// @param to where a non-collateral token goes. Collateral is IGNORED here and
    ///        joins the float instead, so the float's accounting cannot be bypassed —
    ///        use `releaseFloat` for that, which Arena's seed ceiling still governs.
    function sweepAccountToken(address account, address token, address to)
        external onlyOwner returns (uint256 moved)
    {
        moved = PerpAccount(account).sweepToken(token);
        if (token != address(collateral) && moved > 0) {
            if (!IERC20Minimal(token).transfer(to, moved)) revert TransferFailed();
        }
        emit StraySwept(token, to, moved);
    }

    /// @notice Send a non-collateral token held by THIS contract somewhere.
    /// @dev    Collateral is refused on purpose. It is the float, and the float leaves
    ///         through `releaseFloat` so that Arena's `seedLiquidity` ceiling — the
    ///         thing that stops house withdrawals touching depositor money — still
    ///         applies. A general sweep here would be a way around it.
    function sweepStray(address token, address to) external onlyOwner returns (uint256 moved) {
        if (token == address(collateral)) revert CannotSweepCollateral();
        moved = IERC20Minimal(token).balanceOf(address(this));
        if (moved > 0 && !IERC20Minimal(token).transfer(to, moved)) revert TransferFailed();
        emit StraySwept(token, to, moved);
    }

    // ─── Reads ────────────────────────────────────────────────────────────────

    function accountOf(uint256 duelId, uint8 fighterId) external view returns (address) {
        return accounts[duelId][fighterId];
    }

    function accountCount() external view returns (uint256) { return allAccounts.length; }
    function accountAt(uint256 i) external view returns (address) { return allAccounts[i]; }
    function freeAt(uint256 i) external view returns (address) { return freeList[i]; }
    function quarantineCount() external view returns (uint256) { return quarantineHistory.length; }
    function quarantineAt(uint256 i) external view returns (address) { return quarantineHistory[i]; }

    /// @notice Every child, paginated. `start` past the end returns empty rather than
    ///         reverting, so a caller can walk to the end without knowing the length.
    function accountsPaginated(uint256 start, uint256 count)
        external view returns (address[] memory page)
    {
        uint256 n = allAccounts.length;
        if (start >= n) return new address[](0);
        uint256 end = start + count;
        if (end > n) end = n;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = allAccounts[i];
    }

    /// @notice Everything an operator needs about one account, in one call.
    ///
    ///         Exists because the alternative is six separate reads against two
    ///         contracts, and the numbers only mean anything together: collateral
    ///         sitting loose in the account is a failed deposit, an open market with
    ///         nothing leased is stuck money, and equity below the margin requirement
    ///         is a fighter about to be liquidated.
    /// @return tag the fight it is leased to, packed `duelId << 8 | fighterId`, or zero.
    function accountReport(address account) external view returns (
        uint256 tag,
        bool    leased,
        bool    isQuarantined,
        bool    priceable,
        int256  equity,
        uint256 imReq,
        uint8   marginStatus,
        uint256 looseCollateral,
        address[] memory openMarkets
    ) {
        tag           = leaseTag[account];
        leased        = inUse[account];
        isQuarantined = quarantined[account];
        looseCollateral = collateral.balanceOf(account);

        try bank.tryGetAccountEquity(account) returns (bool ok, int256 e) {
            priceable = ok;
            equity = e;
        } catch {}
        try bank.getAccountHealth(account) returns (int256, uint256 im, uint256, uint256) {
            imReq = im;
        } catch {}
        try bank.getMarginStatus(account) returns (uint8 st) { marginStatus = st; } catch {}
        try bank.getActivePerpPools(account) returns (address[] memory p) { openMarkets = p; } catch {}
    }

    /// @notice Unpack a lease tag into the pair every rescue function is keyed on.
    function unpackTag(uint256 tag) external pure returns (uint256 duelId, uint8 fighterId) {
        return (tag >> 8, uint8(tag & 0xff));
    }

    /// @notice A fighter's whole score in one number, sign included.
    /// @dev    The non-reverting variant on purpose. A stale oracle must let the
    ///         caller fall back to its own snapshot, not take the duel down.
    function equityOf(uint256 duelId, uint8 fighterId) external view returns (bool ok, int256 equity) {
        address account = accounts[duelId][fighterId];
        if (account == address(0)) return (false, 0);
        try bank.tryGetAccountEquity(account) returns (bool o, int256 e) {
            return (o, e);
        } catch { return (false, 0); }
    }

    /// @notice Collateral this fighter could still put behind a NEW position.
    /// @dev    Deliberately not `getWithdrawableCollateral`, which ignores the
    ///         initial margin an open position already needs — measured returning
    ///         the full deposit with a short open against it.
    function freeMarginOf(address account) public view returns (uint256) {
        try bank.getAccountHealth(account) returns (int256 equity, uint256 imReq, uint256, uint256) {
            if (equity <= 0) return 0;
            uint256 eq = uint256(equity);
            return eq > imReq ? eq - imReq : 0;
        } catch { return 0; }
    }

    /// @notice Whether this fighter may open (or extend) each direction on `market`
    ///         right now. A move it cannot execute must never be offered.
    /// @dev    Reducing an existing position needs no new margin, which is why a
    ///         fighter already facing one way can always turn back even when it has
    ///         no free margin left. That is also what lets Short-then-Long return an
    ///         account to flat rather than opening a second position.
    function tradability(address market, uint256 duelId, uint8 fighterId)
        external view returns (bool canLong, bool canShort)
    {
        address account = accounts[duelId][fighterId];
        if (account == address(0)) return (false, false);

        (bool tradable, uint256 imPerLot) = marketCost(market);
        if (!tradable) return (false, false);

        int128 size = _sizeOf(account, market);
        bool affordable = freeMarginOf(account) >= imPerLot;

        // A buy needs someone selling, a sell needs someone buying.
        canLong  = _hasSize(market, false) && (size < 0 || affordable);
        canShort = _hasSize(market, true)  && (size > 0 || affordable);
    }

    /// @return side -1 short, 0 flat, 1 long.
    function sideOf(address market, uint256 duelId, uint8 fighterId) external view returns (int8 side) {
        address account = accounts[duelId][fighterId];
        if (account == address(0)) return 0;
        int128 size = _sizeOf(account, market);
        return size > 0 ? int8(1) : (size < 0 ? int8(-1) : int8(0));
    }

    function marginStatusOf(uint256 duelId, uint8 fighterId) external view returns (uint8) {
        address account = accounts[duelId][fighterId];
        if (account == address(0)) return 0;
        try bank.getMarginStatus(account) returns (uint8 s) { return s; } catch { return 0; }
    }

    function _sizeOf(address account, address market) internal view returns (int128) {
        try bank.getPosition(account, market) returns (int128 size, uint128, int256, uint64) {
            return size;
        } catch { return 0; }
    }

    function _tryMark(address market) internal view returns (bool, uint256) {
        try IPerpPool(market).tryGetMarkPrice() returns (bool ok, uint256 price) {
            return (ok, price);
        } catch { return (false, 0); }
    }

    function _hasSize(address market, bool isBid) internal view returns (bool) {
        try IPerpPool(market).getBookLevels(isBid, 1) returns (OrderBookLevel[] memory lv) {
            return lv.length > 0 && lv[0].quantity > 0;
        } catch { return false; }
    }
}
