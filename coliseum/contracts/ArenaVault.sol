// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/ArenaTypes.sol";
import "./interfaces/ISpotPool.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/ISomniaReactivityPrecompile.sol";

/// @title ArenaVault
/// @notice Abstract base for Arena. Handles all fund management: pool seeding,
///         vault recovery, token sweeps, native STT, platform fees, and
///         Reactivity subscription management.
///         Separated from Arena.sol so fund-custody logic can be audited in isolation.
abstract contract ArenaVault {

    using ArenaTypes for *;

    // ─── Constants ────────────────────────────────────────────────────────────

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant REACTIVITY_FUND_MIN = 33 ether;

    /// @notice Platform fee scales with duel length to track LLM inference cost,
    ///         which grows with turns (≈0.24 STT/move × 2 fighters × turns). Flat
    ///         fees over-charge short duels and under-charge long ones, so the fee
    ///         is hybrid: fee = base + perTurn × turns (18-decimal USDso).
    ///         e.g. turns=3 → 0.8, turns=6 → 1.1, turns=9 → 1.4, turns=15 → 2.0.
    uint256 public constant PLATFORM_FEE_BASE     = 0.5e18;
    uint256 public constant PLATFORM_FEE_PER_TURN = 0.1e18;

    /// @notice Turn-scaled platform fee collected at startDuel.
    function platformFee(uint16 turns) public pure returns (uint256) {
        return PLATFORM_FEE_BASE + PLATFORM_FEE_PER_TURN * uint256(turns);
    }

    // ─── State ────────────────────────────────────────────────────────────────

    address public immutable USDSO;
    address public immutable POOL_WETH;
    address public immutable POOL_WBTC;
    address public immutable POOL_SOMI;
    address public owner;
    uint256 public subscriptionId;
    uint256 public accruedFees;

    /// @notice Sum of all un-recovered duel pots currently escrowed in this
    ///         contract's USDso balance. withdrawFees() never dips below this, so
    ///         platform-fee withdrawal can never touch depositor principal.
    ///         Incremented in startDuel, decremented in recoverFunds.
    uint256 public escrowedPot;

    /// @notice Running total of USDso the OWNER has seeded into pool vaults via
    ///         fundPools(). Tracked separately from user duel deposits so the
    ///         owner can withdraw their own seed liquidity without touching
    ///         depositor funds. Incremented in fundPools, decremented in
    ///         ownerWithdrawSeed.
    uint256 public seedLiquidity;

    mapping(address => ArenaTypes.PoolMeta) public poolMeta;

    // ─── Modifier ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert ArenaTypes.NotOwner();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _usdso,
        address _poolWeth,
        address _poolWbtc,
        address _poolSomi
    ) {
        USDSO     = _usdso;
        POOL_WETH = _poolWeth;
        POOL_WBTC = _poolWbtc;
        POOL_SOMI = _poolSomi;
        owner     = msg.sender;
    }

    receive() external payable {}

    // ─── Pool metadata ────────────────────────────────────────────────────────

    function _cachePoolMeta(address pool, uint8 baseDecimals) internal {
        try ISpotPool(pool).getPoolParams() returns (
            address, address, uint256, uint256,
            uint256 tickSize, uint256 minQty, uint256 lotSize
        ) {
            poolMeta[pool] = ArenaTypes.PoolMeta({
                baseDecimals: baseDecimals,
                minQuantity:  minQty,
                lotSize:      lotSize,
                tickSize:     tickSize
            });
        } catch {
            poolMeta[pool] = ArenaTypes.PoolMeta({
                baseDecimals: baseDecimals,
                minQuantity:  0,
                lotSize:      1,
                tickSize:     1
            });
        }
    }

    // ─── Pool seeding (owner-only) ────────────────────────────────────────────

    /// @notice Seed all three pool vaults with equal USDso amounts.
    ///         Call before the first duel. Caller must have approved usdsoPerPool × 3.
    function fundPools(uint256 usdsoPerPool) external onlyOwner {
        if (usdsoPerPool == 0) revert ArenaTypes.ZeroAmount();
        address[3] memory pools = [POOL_WETH, POOL_WBTC, POOL_SOMI];
        uint256 totalDeposited = usdsoPerPool * 3;
        for (uint256 i = 0; i < 3; i++) {
            address pool = pools[i];
            bool ok = IERC20Minimal(USDSO).transferFrom(msg.sender, address(this), usdsoPerPool);
            if (!ok) revert ArenaTypes.TransferFailed();
            ok = IERC20Minimal(USDSO).approve(pool, usdsoPerPool);
            if (!ok) revert ArenaTypes.ApproveFailed();
            ISpotPool(pool).deposit(USDSO, usdsoPerPool);
        }
        // Track owner seed so it can be withdrawn later via ownerWithdrawSeed.
        seedLiquidity += totalDeposited;
        emit ArenaTypes.PoolsFunded(usdsoPerPool, totalDeposited);
    }

    /// @notice Withdraw owner-seeded USDso (vault liquidity) back to a recipient.
    ///         Bounded by `seedLiquidity` so this cannot touch user duel deposits.
    ///         Caller must first pull pool balances back to the contract via
    ///         withdrawFromPool() before calling this.
    function ownerWithdrawSeed(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        if (amount > seedLiquidity) revert ArenaTypes.ZeroAmount();
        seedLiquidity -= amount;
        bool ok = IERC20Minimal(USDSO).transfer(to, amount);
        if (!ok) revert ArenaTypes.TransferFailed();
        emit ArenaTypes.SeedWithdrawn(to, amount);
    }

    // ─── Fund recovery (owner-only) ───────────────────────────────────────────

    /// @notice Pull vault funds from a pool back into this contract's ERC20 balance.
    function withdrawFromPool(address pool, address token, uint256 amount) external onlyOwner {
        _requireValidPool(pool);
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        ISpotPool(pool).withdraw(token, amount);
        emit ArenaTypes.VaultWithdrawn(pool, token, amount);
    }

    /// @notice Transfer any non-USDso ERC20 held by this contract to a recipient.
    ///         USDso is explicitly blocked because the contract holds user duel deposits
    ///         in its USDso balance; sweeping them would steal from depositors. Use
    ///         withdrawFees() to extract accumulated platform fees instead.
    function sweepToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == USDSO) revert ArenaTypes.CannotSweepUSDso();
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        bool ok = IERC20Minimal(token).transfer(to, amount);
        if (!ok) revert ArenaTypes.TransferFailed();
        emit ArenaTypes.TokenSwept(token, to, amount);
    }

    /// @notice Withdraw native STT held by this contract.
    function withdrawNative(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert ArenaTypes.TransferFailed();
        emit ArenaTypes.NativeWithdrawn(to, amount);
    }

    // ─── Platform fees ────────────────────────────────────────────────────────

    /// @notice Withdraw accumulated platform fees to a recipient. Caps the transfer
    ///         at the contract's actual USDso balance — `accruedFees` is an
    ///         accounting counter that can drift slightly above the real balance
    ///         due to rounding in fighter-balance math when pots get traded into
    ///         base tokens that don't round-trip cleanly back to quote.
    function withdrawFees(address to) external onlyOwner {
        uint256 amount = accruedFees;
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        // Only the balance above escrowed duel pots is withdrawable as fees, so
        // this can never pay out depositor principal still held in escrow.
        uint256 bal  = IERC20Minimal(USDSO).balanceOf(address(this));
        uint256 free = bal > escrowedPot ? bal - escrowedPot : 0;
        if (free < amount) amount = free;
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        accruedFees = 0;
        bool ok = IERC20Minimal(USDSO).transfer(to, amount);
        if (!ok) revert ArenaTypes.TransferFailed();
        emit ArenaTypes.FeesWithdrawn(to, amount);
    }

    // ─── Reactivity subscription ─────────────────────────────────────────────

    function _subscribeReactivity() internal returns (uint256 newId) {
        ISomniaReactivityPrecompile.SubscriptionData memory data = ISomniaReactivityPrecompile.SubscriptionData({
            eventTopics: [
                keccak256("BlockTick(uint64)"),
                bytes32(0),
                bytes32(0),
                bytes32(0)
            ],
            origin:                  address(0),
            caller:                  address(0),
            emitter:                 SOMNIA_REACTIVITY_PRECOMPILE,
            handlerContractAddress:  address(this),
            handlerFunctionSelector: _onEventSelector(),
            // Priority fee must be high enough to win the per-block reactivity queue.
            // Testnet baseFee is ~6 gwei; lower-priority subs get indefinitely deferred
            // even though the subscription stays alive. 10 gwei tip puts us above most
            // background traffic.
            priorityFeePerGas:       10_000_000_000,
            // maxFeePerGas must be >= priorityFeePerGas + baseFee.
            maxFeePerGas:            50_000_000_000,
            // Arena _runTurn does pool snapshots + 2 LLM createRequest calls — heavy
            // path. 3M gas was tight; reactive txs were silently failing on
            // out-of-gas with no event. Bumped to 15M (well under the 200M cap).
            gasLimit:                15_000_000,
            isGuaranteed:            false,
            isCoalesced:             false
        });

        bytes memory callData = abi.encodeWithSelector(
            ISomniaReactivityPrecompile.subscribe.selector,
            data
        );
        (bool ok, bytes memory ret) = SOMNIA_REACTIVITY_PRECOMPILE.call(callData);
        if (ok && ret.length >= 32) {
            newId = abi.decode(ret, (uint256));
        } else {
            newId = 0;
            emit ArenaTypes.SubscriptionSkipped("precompile unavailable");
        }
    }

    /// @dev Derived contract must supply its onEvent selector for the subscription.
    function _onEventSelector() internal pure virtual returns (bytes4);

    function resubscribe() external onlyOwner returns (uint256 newId) {
        if (address(this).balance < REACTIVITY_FUND_MIN) revert ArenaTypes.ReactivityUnderfunded();
        newId = _subscribeReactivity();
        subscriptionId = newId;
        emit ArenaTypes.Resubscribed(newId);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _requireValidPool(address pool) internal view {
        if (pool != POOL_WETH && pool != POOL_WBTC && pool != POOL_SOMI)
            revert ArenaTypes.InvalidPool(pool);
    }
}
