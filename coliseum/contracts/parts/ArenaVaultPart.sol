// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../interfaces/ISpotPool.sol";
import "../interfaces/IERC20Minimal.sol";
import "../interfaces/ISomniaReactivityPrecompile.sol";
import "../interfaces/IPerps.sol";

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

    /// @notice Register the event-contract pool set, in [WETH, WBTC, SOMI] order.
    ///         Each slot is normally an EventDesk standing in front of a dreamDEX
    ///         prediction market, but an ordinary spot pool is equally valid —
    ///         Arena only needs an address that answers a pool's questions.
    ///
    ///         Expected to be called repeatedly, because a prediction window opens
    ///         at a fresh address every few minutes and the old one stops trading.
    ///         Safe to call between duels at any time: every duel records its own
    ///         pool set when it starts, so re-pointing this cannot disturb a fight
    ///         already underway.
    ///
    ///         Re-registering also refreshes each address's cached trading rules,
    ///         which is how a pool's tick or minimum size can change without a
    ///         redeploy.
    /// @param labels the question each slot asks, in a few characters and with no
    ///        spaces ("BTCUP"). A slot with an empty label is treated as an
    ///        ordinary asset — which is how the SOMI slot keeps its spot book — and
    ///        a slot with one is described to fighters as a question about odds
    ///        rather than as a price. The label becomes part of the action name the
    ///        model answers with, so changing it changes the fighter's vocabulary.
    function setEventDesks(
        address[3] memory pools,
        uint8[3]   memory baseDecimals,
        bytes8[3]  memory labels
    ) external onlyOwner {
        for (uint256 i = 0; i < 3; i++) {
            if (pools[i] == address(0)) revert ArenaTypes.InvalidPool(pools[i]);
            _cachePoolMeta(pools[i], baseDecimals[i], labels[i]);
        }
        EVENT_POOL_WETH = pools[0];
        EVENT_POOL_WBTC = pools[1];
        EVENT_POOL_SOMI = pools[2];
        eventPoolsSet = true;
        emit ArenaTypes.EventDesksSet(pools[0], pools[1], pools[2]);
    }

    // ─── Perp desks (owner-only) ──────────────────────────────────────────────

    /// @notice Register the permanent perp desks and the registry that leases fighter
    ///         accounts behind them.
    ///
    ///         Unlike `setEventDesks`, this is expected to be called ONCE. A
    ///         prediction window opens at a fresh address every few minutes, which is
    ///         why an event desk is re-pointed constantly; the six perp markets were
    ///         deployed once and never expire. Re-calling it is still allowed — a desk
    ///         can be redeployed, and cached trading rules can go stale — but a desk
    ///         already registered is never un-registered, because a fight that started
    ///         on it must keep working.
    ///
    /// @param desks_ every desk, in any order. There is no [WETH, WBTC, SOMI] slot
    ///        meaning here: which three a fight gets is chosen per fight from what its
    ///        budget affords, so the set registered is a MENU, not a lineup.
    /// @param baseDecimals each market's base-asset decimals, supplied rather than
    ///        read on chain because a perp's base asset is synthetic and has no token
    ///        to ask. Derive them from the desk's own `oneBase()` — never a table.
    /// @param labels the market's name in a few characters ("ETH"). This becomes part
    ///        of the action the model answers with, so it is the difference between a
    ///        fighter being offered `LongETH` and being offered nothing it recognises.
    function setPerpDesks(
        address          registry_,
        address[] calldata desks_,
        uint8[]   calldata baseDecimals,
        bytes8[]  calldata labels
    ) external onlyOwner {
        if (registry_ == address(0)) revert ArenaTypes.InvalidPool(registry_);
        if (desks_.length == 0 || desks_.length != baseDecimals.length || desks_.length != labels.length)
            revert ArenaTypes.ZeroAmount();

        // MOVING THE REGISTRY IS ONLY SAFE WHILE NOTHING IS RUNNING.
        //
        // A desk is bound to its registry at construction and cannot be re-pointed,
        // but Arena's pointer can — and a running perps fight reads it twice more:
        // once to score each fighter and once to close their positions. Swap it
        // mid-fight and both reads go to a registry that has never heard of that
        // duel: the fighters would score off stale snapshots and their collateral
        // would sit in the old registry with nothing pointing at it. Adding desks to
        // the SAME registry is always fine, which is the case that actually happens.
        if (perpDesksSet && registry_ != perpRegistry && activeDuelIds.length != 0)
            revert ArenaTypes.ArenaNotEmpty();
        for (uint256 i = 0; i < desks_.length; i++) {
            if (desks_[i] == address(0)) revert ArenaTypes.InvalidPool(desks_[i]);
            // Before caching, so `_requireValidPool` already accepts the address and
            // the ordering can never be the thing that breaks a re-registration.
            poolIsPerp[desks_[i]] = true;
            _cachePoolMeta(desks_[i], baseDecimals[i], labels[i]);
        }
        perpRegistry = registry_;
        perpDesksSet = true;
        emit ArenaTypes.PerpDesksSet(registry_, desks_);
    }

    /// @notice Lend USDso to the registry, which is what funds each fighter's margin.
    ///
    ///         This is the ONE structural difference from spot in how money moves. On
    ///         spot the players' pot is the trading capital: it is seeded into the
    ///         vaults and traded directly. On perps the pot stays escrowed and is
    ///         returned in full — what the fighters actually risk is Arena's own seed,
    ///         lent out at the start of each fight and reclaimed at the end. So a
    ///         liquidation costs the house, never the players, which is the right way
    ///         round: nobody should lose their stake because a model over-traded.
    ///
    ///         Tracked in `seedLiquidity` like every other owner seed, so it comes
    ///         back out through `ownerWithdrawSeed` and can never be mistaken for
    ///         depositor principal.
    function fundPerpFloat(uint256 amount) external onlyOwner {
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        if (!perpDesksSet) revert ArenaTypes.PerpRegistryUnset();
        bool ok = IERC20Minimal(USDSO).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert ArenaTypes.TransferFailed();
        ok = IERC20Minimal(USDSO).approve(perpRegistry, amount);
        if (!ok) revert ArenaTypes.ApproveFailed();
        IPerpRegistry(perpRegistry).fundFloat(amount);
        seedLiquidity += amount;
        emit ArenaTypes.PoolsFunded(amount, amount);
    }

    /// @notice Pull unlent collateral back from the registry into Arena's own balance,
    ///         where `ownerWithdrawSeed` can pay it out. Two steps rather than one on
    ///         purpose: the seed ceiling that stops a withdrawal touching depositor
    ///         money lives in that function, and routing around it to save a call
    ///         would route around the check as well.
    function withdrawPerpFloat(uint256 amount) external onlyOwner {
        if (amount == 0) revert ArenaTypes.ZeroAmount();
        if (!perpDesksSet) revert ArenaTypes.PerpRegistryUnset();
        IPerpRegistry(perpRegistry).releaseFloat(amount, address(this));
        emit ArenaTypes.VaultWithdrawn(perpRegistry, USDSO, amount);
    }

    /// @notice Re-read the trading rules of pools Arena already knows, without
    ///         changing which pools they are.
    ///
    ///         Closes audit item M1. Those rules — tick size, minimum order size,
    ///         lot size — were cached once at deploy and never refreshed, so if
    ///         dreamDEX changed one, Arena kept sizing orders against the stale
    ///         value and the only cure was a full redeploy. Duels already record
    ///         their own pool set, so refreshing here cannot disturb a running
    ///         fight; it only changes how later orders are sized.
    function refreshPoolMeta(
        address[] calldata pools,
        uint8[]   calldata baseDecimals
    ) external onlyOwner {
        if (pools.length != baseDecimals.length) revert ArenaTypes.ZeroAmount();
        for (uint256 i = 0; i < pools.length; i++) {
            // Only pools Arena already trades on — never an arbitrary address.
            _requireValidPool(pools[i]);
            _cachePoolMeta(pools[i], baseDecimals[i]);
        }
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
    //
    // The subscribing and cancelling machinery lives in ArenaStorage, because the
    // turn part and the duel part both need it and no part may hold state of its
    // own. These two are the owner's switches.

    /// @notice Switch turns over to Reactivity, and arm immediately if a fight is
    ///         already running. Named resubscribe() rather than something clearer
    ///         on purpose: changing a function's signature leaves its old selector
    ///         routed at retired code running against live storage, so an existing
    ///         entry point is reused wherever the body can carry the change.
    ///
    ///         The balance floor is checked here even though a one-shot chain costs
    ///         pennies per fight, because the precompile refuses a subscription
    ///         outright below its own minimum, and a silent refusal reads exactly
    ///         like a working switch.
    function resubscribe() external onlyOwner returns (uint256 newId) {
        if (address(this).balance < REACTIVITY_FUND_MIN) revert ArenaTypes.ReactivityUnderfunded();
        reactivityOn = true;
        _scheduleNextTick();
        newId = subscriptionId;
        emit ArenaTypes.Resubscribed(newId);
    }


    /// @notice Switch Reactivity off and cancel anything armed. The keeper bot takes
    ///         turns over again the moment this lands, so this is the rollback — no
    ///         redeploy, no rewiring.
    function disableReactivity() external onlyOwner {
        reactivityOn = false;
        _cancelTick();
        emit ArenaTypes.ReactivityDisabled();
    }
}
