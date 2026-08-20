// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IPerps.sol";
import "./interfaces/IERC20Minimal.sol";

/// @title  PerpAccount
/// @notice One fighter's trading identity for the length of one duel.
///
/// WHY THIS CONTRACT EXISTS AT ALL. Margin on dreamDEX is CROSS and keyed on the
/// trading ADDRESS: everything one address holds is pooled into a single health
/// figure, and any of it can be seized to cover any other part of it. Arena is a
/// single address keeping a private ledger of who owns what inside a shared vault.
/// For spot that ledger is honest, because a vault is only custody. For perps it
/// would be a lie — two fighters trading from Arena's address would share one
/// margin pool, and a liquidation caused by one could take collateral backing the
/// other. So each fighter gets its own address, and that address is this.
///
/// The protocol's own `ticket-25-isolated-margin-mode-build-plan.md` reaches the
/// same conclusion from the other direction: an account holding exactly one market
/// is mathematically identical under cross and isolated margin, so isolation is
/// achieved by separating ADDRESSES, never by margin arithmetic.
///
/// Deliberately tiny. It holds collateral, places its own orders, and answers only
/// to the registry that leased it. Every decision — which market, which direction,
/// how large, when to stop — is made above it.
///
/// THE ZERO-ALLOWANCE RULE. When an order needs more margin than the account holds,
/// the protocol does not simply refuse: it tries to pull the shortfall out of the
/// trader's own token balance. Measured 2026-08-19 — a 4-lot order short of margin
/// attempted a `transferFrom` and failed with `ERC20InsufficientAllowance(bank, 0,
/// 8.27e18)`, the third field being the exact shortfall. So funding here always
/// ends by returning the allowance to ZERO. Then a fighter is hard-capped by the
/// collateral it was given, an overdraw cannot succeed, and the failure mode is a
/// clean refusal instead of a silent raid on the shared float.
contract PerpAccount {
    address public immutable registry;
    IERC20Minimal public immutable collateral;
    IMarginBank  public immutable bank;

    error NotRegistry();
    error TransferFailed();
    error ApproveFailed();

    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
        _;
    }

    constructor(address collateral_, address bank_) {
        registry   = msg.sender;
        collateral = IERC20Minimal(collateral_);
        bank       = IMarginBank(bank_);
    }

    /// @notice Place `amount` of collateral, already sitting in this contract, into
    ///         the margin bank as this account's own margin.
    /// @dev    The approval is to the bank, not to any pool: the trading engine
    ///         never touches tokens. `deposit` consumes exactly `amount`, so the
    ///         allowance is already zero afterwards — it is set to zero explicitly
    ///         anyway, because "already zero by arithmetic" is the kind of thing
    ///         that stops being true when someone changes an unrelated line.
    function fund(uint256 amount) external onlyRegistry {
        // Return values are checked throughout. A token that reports failure by
        // returning false rather than reverting would otherwise leave this account
        // holding tokens it never deposited, and the fighter would be offered moves it
        // has no margin for — the failure arriving a turn later, as a refused order.
        if (!collateral.approve(address(bank), amount)) revert ApproveFailed();
        bank.deposit(amount);
        if (!collateral.approve(address(bank), 0)) revert ApproveFailed();
    }

    /// @notice Place an order as this account, on its own behalf.
    ///
    ///         Tolerates both refusal shapes. The interface docs upstream say a
    ///         rejected order reverts; the DEPLOYED pool returns `(false, 0)` with
    ///         no revert — measured 2026-08-19, the bytecode predates the change
    ///         described in its own interface. Both are handled because a beacon
    ///         upgrade could switch which one happens without warning, and because
    ///         a revert here would take down a whole turn for one bad market.
    ///
    ///         The catch is bare on purpose: the errors are CUSTOM, so
    ///         `catch Error(string)` would never match one of them.
    function trade(
        address pool,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType
    ) external onlyRegistry returns (bool ok, uint128 orderId) {
        try IPerpPool(pool).placeOrder(
            isBid, userData, price, quantity, expireTimestampNs, orderType, 0, address(0), 0
        ) returns (bool success, uint128 id) {
            return (success, id);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Place an order as this account, STRICTLY — used only by the owner's
    ///         `forceClose` rescue, never by a desk or by wind-down.
    ///
    ///         Measured 2026-08-19: the deployed pool's oracle price-resolution path
    ///         can silently burn far more gas than a healthy read costs (one observed
    ///         static read alone consumed 960,593 gas against a normal cost of
    ///         25,394 — a 37x blowup), and under EIP-150 the 63/64 rule starves that
    ///         inner frame whenever the outer call's own gas limit was sized by
    ///         estimation against a bare `try/catch` — because the catch reports
    ///         success regardless, `eth_estimateGas` converges on a limit that is
    ///         just barely enough to REACH the swallowed failure, never enough to
    ///         survive it. Three live `forceClose` attempts ran at 96.4%-99.3% of
    ///         their limit with `ok=false` and no revert: a transaction succeeding
    ///         while eating its whole limit, with the failure hidden, is exactly what
    ///         a swallowed internal out-of-gas looks like.
    ///
    ///         This function has no catch, so a revert OR an out-of-gas below it
    ///         propagates instead of being reported as a clean refusal. That turns a
    ///         silent, gas-poisoned failure into an honest one `eth_estimateGas` can
    ///         actually size for — exactly what `contracts/probe/AccountProbe.sol`
    ///         demonstrated live: same calldata, a `revert` instead of a catch, and
    ///         estimation gave it a 2,032,114 gas limit that closed the position
    ///         cleanly using 688,713.
    ///
    ///         Never used by `trade` above. That function's tolerance is deliberate
    ///         and load-bearing for the live-fight and wind-down paths — see its own
    ///         doc comment — and must not be touched.
    function tradeStrict(
        address pool,
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType
    ) external onlyRegistry returns (bool ok, uint128 orderId) {
        return IPerpPool(pool).placeOrder(
            isBid, userData, price, quantity, expireTimestampNs, orderType, 0, address(0), 0
        );
    }

    /// @notice Take margin back out and hand it to the registry.
    /// @dev    Withdrawal is REFUSED while a position is open if it would break
    ///         initial margin (`InsufficientMarginAfterWithdrawal`, confirmed live),
    ///         so the caller flattens first. Tolerating the refusal rather than
    ///         reverting is what keeps a failed reclaim from freezing a duel.
    /// @return moved how much actually reached the registry.
    function reclaim(uint256 amount) external onlyRegistry returns (uint256 moved) {
        if (amount == 0) return 0;
        try bank.withdraw(amount) {
            // Sweep the whole balance rather than `amount`: a settlement rounding
            // remainder left behind here would be stranded forever, since nothing
            // else ever looks at this address again.
            moved = collateral.balanceOf(address(this));
            if (moved > 0 && !collateral.transfer(registry, moved)) revert TransferFailed();
        } catch {
            return 0;
        }
    }

    /// @notice Move any loose collateral back to the registry without touching the
    ///         bank. Covers the case where tokens arrived but the deposit failed.
    function sweep() external onlyRegistry returns (uint256 moved) {
        moved = collateral.balanceOf(address(this));
        if (moved > 0 && !collateral.transfer(registry, moved)) revert TransferFailed();
    }

    /// @notice Move ANY token's whole balance back to the registry.
    ///
    ///         An account is a plain address as far as the rest of the chain is
    ///         concerned, so anything can be sent to it — an airdrop, a fat-fingered
    ///         transfer, a token the protocol pays a rebate in. Without this the
    ///         only balance that could ever leave here is the collateral, and
    ///         everything else would sit in a contract nobody looks at again once
    ///         the fight it served is over.
    ///
    ///         Only the registry may ask, and the tokens can only go to the
    ///         registry — so this is a recovery path, never a redirection.
    function sweepToken(address token) external onlyRegistry returns (uint256 moved) {
        IERC20Minimal t = IERC20Minimal(token);
        moved = t.balanceOf(address(this));
        if (moved > 0 && !t.transfer(registry, moved)) revert TransferFailed();
    }
}
