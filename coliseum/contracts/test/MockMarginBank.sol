// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  MockMarginBank
/// @notice A small, faithful stand-in for the dreamDEX `MarginBank`.
///
///         Test-only, but deliberately not a stub. Four of its behaviours are the
///         ones the perps design actually rests on, and a mock that merely returned
///         plausible numbers would let all four regress silently:
///
///          1. EQUITY IS SIGNED AND MARKS A SHORT CORRECTLY. Measured against the
///             real bank to zero wei of drift:
///             `equity == deposit + size x (mark - entry)`, with `size` negative for
///             a short. This is the fighter's whole score, so the sign is the feature.
///
///          2. CROSS MARGIN IS KEYED ON THE ADDRESS. Everything an address holds is
///             pooled into one health figure. That is why each fighter needs an
///             address of its own, and a mock keying by (address, market) would make
///             the bug this design exists to avoid untestable.
///
///          3. A SHORTFALL IS AUTO-PULLED FROM THE TRADER'S TOKEN BALANCE. The real
///             bank does not simply refuse an under-margined order: it attempts a
///             `transferFrom` on the trader and fails with
///             `ERC20InsufficientAllowance(bank, 0, shortfall)`. That is the entire
///             reason fighter accounts keep their allowance at zero, so the mock has
///             to attempt the pull too.
///
///          4. WITHDRAWAL IS REFUSED WHILE A POSITION NEEDS THE MARGIN. Confirmed
///             live. `getWithdrawableCollateral` is also modelled with its real,
///             misleading behaviour — it reports unlocked collateral and IGNORES
///             position margin — because code that trusted it would look correct
///             against a "helpful" mock and strand money against the real one.
contract MockMarginBank {

    struct Position {
        int128  size;
        uint128 avgEntryPrice;
    }

    IMockToken public immutable collateral;

    /// @notice Unlocked collateral, SIGNED — as the real `AccountState` declares it,
    ///         and for the real reason: settling a loss can take an account into
    ///         deficit, and realised profit and loss settles INTO this balance rather
    ///         than being tracked beside it. An earlier version of this mock kept
    ///         realised PnL in its own mapping, which made `getWithdrawableCollateral`
    ///         over-report by exactly the amount a round trip had cost and turned
    ///         every reclaim into a refused withdrawal.
    mapping(address => int256) public balances;
    mapping(address => mapping(address => Position)) internal _positions;
    mapping(address => address[]) internal _active;
    mapping(address => mapping(address => bool)) internal _isActive;

    /// @notice Only a registered market may settle a fill.
    mapping(address => bool) public isMarket;

    error InsufficientMarginForOrder();
    error InsufficientMarginAfterWithdrawal();
    error NotMarket();
    error NotPriceable();

    event Settled(address indexed account, address indexed market, int128 newSize, uint128 avgEntry, int256 balance);

    constructor(address collateral_) {
        collateral = IMockToken(collateral_);
    }

    function registerMarket(address market, bool ok) external { isMarket[market] = ok; }

    // ─── Collateral ───────────────────────────────────────────────────────────

    function deposit(uint256 amount) external {
        collateral.transferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += int256(amount);
    }

    function withdraw(uint256 amount) external {
        (int256 equity, uint256 imReq,,) = getAccountHealth(msg.sender);
        // The real refusal: taking this out would leave the open position
        // under-margined. Note it is equity, not the balance, that is tested.
        if (equity < 0 || uint256(equity) < imReq + amount) revert InsufficientMarginAfterWithdrawal();
        if (balances[msg.sender] < int256(amount)) revert InsufficientMarginAfterWithdrawal();
        balances[msg.sender] -= int256(amount);
        collateral.transfer(msg.sender, amount);
    }

    /// @notice Unlocked collateral — and NOT the free-margin figure. Reports the
    ///         whole deposit even with a position open against it, exactly as the
    ///         real one was measured doing.
    function getWithdrawableCollateral(address account) external view returns (uint256) {
        int256 b = balances[account];
        return b > 0 ? uint256(b) : 0;
    }

    // ─── Settlement ───────────────────────────────────────────────────────────

    /// @notice Apply a fill. Called by a market, never directly.
    /// @dev    Splits the fill into the part that REDUCES the existing position —
    ///         which realises profit or loss and needs no new margin — and the part
    ///         that opens or extends, which does. A flip through flat is both at
    ///         once, which is why this is not a single branch.
    function applyFill(address account, address market, bool isBid, uint256 price, uint256 quantity) external {
        if (!isMarket[msg.sender]) revert NotMarket();

        Position memory p = _positions[account][market];
        int256 signed = isBid ? int256(quantity) : -int256(quantity);
        uint256 oneBase = IMockMarket(market).getOneBase();

        int256 oldSize = int256(p.size);
        int256 newSize = oldSize + signed;

        // Reducing: the overlap between the old position and the opposite-signed fill.
        if (oldSize != 0 && ((oldSize > 0) != isBid)) {
            uint256 closing = _abs(oldSize) < quantity ? _abs(oldSize) : quantity;
            int256 pnl = oldSize > 0
                ? int256(closing) * (int256(price) - int256(uint256(p.avgEntryPrice)))
                : int256(closing) * (int256(uint256(p.avgEntryPrice)) - int256(price));
            balances[account] += pnl / int256(oneBase);
        }

        // Opening or extending: the entry price is the size-weighted average, which
        // for a flip is just the fill price because the old position is gone.
        if (newSize == 0) {
            p.avgEntryPrice = 0;
        } else if (oldSize == 0 || (oldSize > 0) == (newSize > 0)) {
            if ((oldSize > 0) == isBid && oldSize != 0) {
                uint256 total = _abs(oldSize) + quantity;
                p.avgEntryPrice = uint128(
                    (_abs(oldSize) * uint256(p.avgEntryPrice) + quantity * price) / total
                );
            } else if (oldSize == 0) {
                p.avgEntryPrice = uint128(price);
            }
        } else {
            p.avgEntryPrice = uint128(price);
        }

        p.size = int128(newSize);
        _positions[account][market] = p;
        _track(account, market, newSize != 0);

        // The margin gate, applied AFTER the new position is in place so it sees the
        // real requirement. On a shortfall the real bank pulls from the trader's own
        // token balance rather than refusing — which is what a zero allowance turns
        // into a clean failure.
        (int256 equity, uint256 imReq,,) = getAccountHealth(account);
        if (equity < 0 || uint256(equity) < imReq) {
            uint256 shortfall = equity < 0 ? imReq + uint256(-equity) : imReq - uint256(equity);
            collateral.transferFrom(account, address(this), shortfall);
            balances[account] += int256(shortfall);
        }

        emit Settled(account, market, p.size, p.avgEntryPrice, balances[account]);
    }

    function _track(address account, address market, bool active) internal {
        if (active) {
            if (!_isActive[account][market]) {
                _isActive[account][market] = true;
                _active[account].push(market);
            }
            return;
        }
        if (!_isActive[account][market]) return;
        _isActive[account][market] = false;
        address[] storage list = _active[account];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == market) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    // ─── Reads ────────────────────────────────────────────────────────────────

    function getAccountEquity(address account) external view returns (int256) {
        (bool ok, int256 equity) = tryGetAccountEquity(account);
        if (!ok) revert NotPriceable();
        return equity;
    }

    function tryGetAccountEquity(address account) public view returns (bool ok, int256 equity) {
        equity = balances[account];
        address[] memory list = _active[account];
        for (uint256 i = 0; i < list.length; i++) {
            (bool priced, uint256 mark) = IMockMarket(list[i]).tryGetMarkPrice();
            // One unreadable market makes the whole account unreadable, because
            // cross margin has no per-market answer to give.
            if (!priced) return (false, 0);
            Position memory p = _positions[account][list[i]];
            uint256 oneBase = IMockMarket(list[i]).getOneBase();
            equity += (int256(p.size) * (int256(mark) - int256(uint256(p.avgEntryPrice)))) / int256(oneBase);
        }
        return (true, equity);
    }

    function getAccountHealth(address account)
        public view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)
    {
        (bool ok, int256 e) = tryGetAccountEquity(account);
        equity = ok ? e : int256(0);
        address[] memory list = _active[account];
        for (uint256 i = 0; i < list.length; i++) {
            (bool priced, uint256 mark) = IMockMarket(list[i]).tryGetMarkPrice();
            if (!priced) continue;
            Position memory p = _positions[account][list[i]];
            uint256 notional = (_abs(int256(p.size)) * mark) / IMockMarket(list[i]).getOneBase();
            uint256 imf = IMockMarket(list[i]).getEffectiveIMF();
            imReq += (notional * imf) / 10_000;
        }
        mmReq = imReq / 2;
        cmReq = imReq / 4;
    }

    function getPosition(address account, address market)
        external view returns (int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdated)
    {
        Position memory p = _positions[account][market];
        return (p.size, p.avgEntryPrice, 0, 0);
    }

    function getActivePerpPools(address account) external view returns (address[] memory) {
        return _active[account];
    }

    function getMarginStatus(address account) external view returns (uint8) {
        (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq) = getAccountHealth(account);
        if (equity >= int256(imReq)) return 0;   // Healthy
        if (equity >= int256(mmReq)) return 1;   // MarginCall
        if (equity >= int256(cmReq)) return 2;   // PartialLiquidation
        return 3;                                // CloseOut
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v < 0 ? uint256(-v) : uint256(v);
    }
}

interface IMockToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IMockMarket {
    function getOneBase() external view returns (uint256);
    function tryGetMarkPrice() external view returns (bool ok, uint256 price);
    function getEffectiveIMF() external view returns (uint256);
}
