// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../interfaces/ISpotPool.sol";
import "../interfaces/IERC20Minimal.sol";
import "../interfaces/ISomniaReactivityPrecompile.sol";

/// @title ArenaVaultPart
/// @notice Everything that moves money in or out of Arena: seeding the pool
///         vaults, registering pool sets, recovering funds, sweeping stray
///         tokens, withdrawing platform fees, and the reactivity subscription.
///         Kept in one file so fund-custody logic can be audited in isolation.
///
///         Deployed on its own and reached through the router by delegatecall, so
///         every transfer here debits the ROUTER's balance, not this contract's —
///         this contract never holds anything.
///
///         Declares no storage. See ArenaStorage.sol for why that rule is absolute.
contract ArenaVaultPart is ArenaStorage {

    using ArenaTypes for *;

    // No constructor and no receive(): both belong to the router. This contract is
    // deployed with no arguments and never holds a balance of its own.

    // ─── Pool seeding (owner-only) ────────────────────────────────────────────

    /// @notice Seed all three pool vaults with equal USDso amounts.
    ///         Call before the first duel. Caller must have approved usdsoPerPool × 3.
    function fundPools(uint256 usdsoPerPool) external onlyOwner {
        _fundPoolSet([POOL_WETH, POOL_WBTC, POOL_SOMI], usdsoPerPool);
    }

    /// @dev Shared seeding loop for both real and simulated pool sets. Pulls
    ///      usdsoPerPool from the owner into each of the three pools' vaults and
    ///      tracks the total as owner seed liquidity.
    function _fundPoolSet(address[3] memory pools, uint256 usdsoPerPool) internal {
        if (usdsoPerPool == 0) revert ArenaTypes.ZeroAmount();
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

    // ─── Simulated market pools (owner-only) ──────────────────────────────────

    /// @notice Register the simulated (mock) pool set the Arena routes to when a
    ///         duel is created with simulated == true. Caches each pool's ABI meta.
    ///         Owner-only; mock base decimals are passed explicitly ([WETH,WBTC,SOMI]).
    function setSimPools(
        address weth,
        address wbtc,
        address somi,
        uint8[3] memory baseDecimals
    ) external onlyOwner {
        if (weth == address(0)) revert ArenaTypes.InvalidPool(weth);
        if (wbtc == address(0)) revert ArenaTypes.InvalidPool(wbtc);
        if (somi == address(0)) revert ArenaTypes.InvalidPool(somi);
        SIM_POOL_WETH = weth;
        SIM_POOL_WBTC = wbtc;
        SIM_POOL_SOMI = somi;
        _cachePoolMeta(weth, baseDecimals[0]);
        _cachePoolMeta(wbtc, baseDecimals[1]);
        _cachePoolMeta(somi, baseDecimals[2]);
        simPoolsSet = true;
    }

    /// @notice Seed the three simulated pool vaults with equal USDso amounts, so
    ///         simulated-duel fighter buys have quote liquidity to draw on. Mirrors
    ///         fundPools(); caller must have approved usdsoPerPool × 3.
    function fundSimPools(uint256 usdsoPerPool) external onlyOwner {
        if (!simPoolsSet) revert ArenaTypes.InvalidPool(address(0));
        _fundPoolSet([SIM_POOL_WETH, SIM_POOL_WBTC, SIM_POOL_SOMI], usdsoPerPool);
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
            handlerFunctionSelector: ON_EVENT_SELECTOR,
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


    function resubscribe() external onlyOwner returns (uint256 newId) {
        if (address(this).balance < REACTIVITY_FUND_MIN) revert ArenaTypes.ReactivityUnderfunded();
        newId = _subscribeReactivity();
        subscriptionId = newId;
        emit ArenaTypes.Resubscribed(newId);
    }
}
