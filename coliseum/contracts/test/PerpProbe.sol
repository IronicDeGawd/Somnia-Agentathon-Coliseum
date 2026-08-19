// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  PerpProbe
/// @notice THROWAWAY. Not part of the Arena. Exists to answer, against the LIVE
///         dreamDEX perpetuals protocol, the handful of load-bearing questions the
///         perps plan rests on — the ones whose answers were read out of the
///         protocol source and therefore not yet actually observed.
///
///         Same role `ReactivitySpike.sol` played for the one-shot tick work: a
///         cheap contract whose only job is to be measured, deleted afterwards.
///
///         The questions, in the order the plan depends on them:
///
///          1. CAN A CONTRACT TRADE AT ALL? A perp order placed by a contract for
///             ITSELF must be admitted with nobody's permission. The source says
///             the `OnlyApprovedContracts` gate sits only on the delegated `…For`
///             variants, so plain `placeOrder` should be open. If that reading is
///             wrong, the whole design dies here and no amount of Arena work saves
///             it, because every fighter account is a contract.
///
///          2. CAN A CONTRACT HOLD MARGIN? `MarginBank.deposit` pulls plain ERC20
///             from `msg.sender` with no KYC, linked-wallet or voucher gate.
///
///          3. CAN A FLAT ACCOUNT GO SHORT? Selling with no prior holding must open
///             a NEGATIVE position rather than revert. This is the difference
///             between "perps" and "spot with extra assets".
///
///          4. DOES EQUITY MOVE THE RIGHT WAY? Account equity is the fighter's
///             score, so a short must be worth MORE as the mark falls. If equity
///             does not respond, the scoring model is wrong.
///
///          5. WHEN IS MONEY STUCK? Withdrawal must refuse while a position is open
///             and succeed once flat. This is the one asymmetry against spot, where
///             a vault always pays back on demand.
///
///         Every write comes in a plain and a `try` flavour. The `try` flavour is
///         the point: a rejected perp order REVERTS with a custom error rather than
///         returning false, so proving a refusal requires catching it and keeping
///         the raw bytes. Catching also means one failed step does not abandon the
///         rest of the run.
contract PerpProbe {
    address public immutable owner;
    IERC20Min public immutable collateral;
    IMarginBankMin public immutable bank;

    error NotOwner();

    event Placed(bool isBid, uint256 price, uint256 quantity, uint8 orderType, uint128 orderId);
    event Refused(string step, bytes reason);
    event Moved(string step, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address collateral_, address bank_) {
        owner = msg.sender;
        collateral = IERC20Min(collateral_);
        bank = IMarginBankMin(bank_);
    }

    // ─── Money in ─────────────────────────────────────────────────────────────

    /// @notice Q2. Pull collateral from the deployer and place it in the strongbox
    ///         as THIS CONTRACT's margin. The approve is to the bank, not the pool:
    ///         the trading engine never touches tokens.
    function fund(uint256 amount) external onlyOwner {
        collateral.transferFrom(msg.sender, address(this), amount);
        collateral.approve(address(bank), amount);
        bank.deposit(amount);
        emit Moved("fund", amount);
    }

    // ─── Trading ──────────────────────────────────────────────────────────────

    /// @notice Q1 / Q3. Place an order as this contract, on its own behalf.
    ///         `userData` is carried through untouched — the plan routes the fighter
    ///         identity through it, so this confirms the field is accepted.
    function trade(
        address pool,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint8   orderType
    ) external onlyOwner returns (uint128 orderId) {
        (, orderId) = IPerpPoolMin(pool).placeOrder(
            isBid, userData, price, quantity, type(uint64).max, orderType, 0, address(0), 0
        );
        emit Placed(isBid, price, quantity, orderType, orderId);
    }

    /// @notice The same, tolerating a refusal. Returns the raw revert bytes so the
    ///         custom error selector can be identified off-chain — `catch Error(string)`
    ///         would never match these, which is itself worth proving once.
    function tryTrade(
        address pool,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint8   orderType
    ) external onlyOwner returns (bool ok, uint128 orderId, bytes memory reason) {
        try IPerpPoolMin(pool).placeOrder(
            isBid, userData, price, quantity, type(uint64).max, orderType, 0, address(0), 0
        ) returns (bool, uint128 id) {
            emit Placed(isBid, price, quantity, orderType, id);
            return (true, id, "");
        } catch (bytes memory err) {
            emit Refused("trade", err);
            return (false, 0, err);
        }
    }

    // ─── Money out ────────────────────────────────────────────────────────────

    /// @notice Q5. Take margin back out and hand it to the deployer.
    function pull(uint256 amount) external onlyOwner {
        bank.withdraw(amount);
        collateral.transfer(owner, amount);
        emit Moved("pull", amount);
    }

    /// @notice The same, tolerating the refusal that is EXPECTED while a position is
    ///         open. A revert here is the finding, not a failure of the probe.
    function tryPull(uint256 amount) external onlyOwner returns (bool ok, bytes memory reason) {
        try bank.withdraw(amount) {
            collateral.transfer(owner, amount);
            emit Moved("pull", amount);
            return (true, "");
        } catch (bytes memory err) {
            emit Refused("pull", err);
            return (false, err);
        }
    }

    // ─── Reads ────────────────────────────────────────────────────────────────

    /// @notice Everything the plan reads per fighter, in one call, from THIS
    ///         contract's own account. `tryGetAccountEquity` rather than the
    ///         reverting variant: a stale oracle must degrade, not explode.
    function state(address pool)
        external view
        returns (
            bool    equityOk,
            int256  equity,
            uint256 withdrawable,
            int128  size,
            uint128 avgEntryPrice,
            uint8   marginStatus
        )
    {
        (equityOk, equity) = bank.tryGetAccountEquity(address(this));
        withdrawable = bank.getWithdrawableCollateral(address(this));
        (size, avgEntryPrice,,) = bank.getPosition(address(this), pool);
        marginStatus = bank.getMarginStatus(address(this));
    }

    /// @notice Escape hatch. A probe that can strand tokens is a probe that has to
    ///         be babysat.
    function sweep(address token) external onlyOwner {
        IERC20Min t = IERC20Min(token);
        uint256 bal = t.balanceOf(address(this));
        if (bal > 0) t.transfer(owner, bal);
    }
}

// ─── Minimal slices of the live protocol ─────────────────────────────────────
// Only what the probe calls. A struct return with all-static members encodes as a
// flat tuple, which is why the parameter and position getters are declared
// unpacked here rather than importing the real structs.

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPerpPoolMin {
    function placeOrder(
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint8   selfMatchingOption,
        address builder,
        uint96  builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 id);
}

interface IMarginBankMin {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function tryGetAccountEquity(address account) external view returns (bool ok, int256 equity);
    function getWithdrawableCollateral(address account) external view returns (uint256);
    function getPosition(address account, address perpPool)
        external view
        returns (int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs);
    function getMarginStatus(address account) external view returns (uint8);
}
