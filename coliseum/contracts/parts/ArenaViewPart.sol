// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../lib/ArenaUtils.sol";
import "../interfaces/IPerps.sol";

/// @title ArenaViewPart
/// @notice Arena's read-only surface, deployed on its own and reached through the
///         router by delegatecall. Nothing here writes, transfers, or approves.
///
///         This group moved out first on purpose: it is the one part where a
///         wiring mistake cannot lose funds.
///
///         Declares no storage — see ArenaStorage.sol for why that rule is
///         absolute. Callers still address the router; they never see this
///         contract's own address, and its own storage stays empty forever.
contract ArenaViewPart is ArenaStorage {

    /// @notice Every running duel id.
    function getActiveDuelIds() external view returns (uint256[] memory) {
        return activeDuelIds;
    }

    /// @notice True when another duel can be started. Matchmaker gates on this.
    function hasCapacity() external view returns (bool) {
        return activeDuelIds.length < maxActiveDuels;
    }

    /// @notice Deprecated single-duel view, kept so older consumers still read
    ///         something sane. Returns the first running duel, or 0 if none.
    ///         Use getActiveDuelIds() — this cannot see the others.
    function activeDuelId() external view returns (uint256) {
        return activeDuelIds.length > 0 ? activeDuelIds[0] : 0;
    }

    /// @notice Running duels whose turn interval has elapsed and which still have
    ///         moves outstanding. The keeper calls this once per tick and then
    ///         turn(id) on each, instead of polling every duel separately.
    function duelsReadyForTurn() external view returns (uint256[] memory ready) {
        uint256[] memory ids = activeDuelIds;
        uint256 n = 0;
        uint256[] memory buf = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            ArenaTypes.Duel storage d = duels[ids[i]];
            if (d.status != ArenaTypes.DuelStatus.Active) continue;
            if (block.number < d.lastTurnBlock + TURN_INTERVAL_BLOCKS) continue;
            if (d.completedCallbacks >= d.turns * 2) continue;
            buf[n++] = ids[i];
        }
        ready = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ready[i] = buf[i];
    }

    /// @notice The three markets a fight is bound to, in [WETH, WBTC, SOMI] order.
    ///
    ///         This exists because a fight's market set CANNOT be inferred from
    ///         anything else. There are three games, and `duel.simulated` is a
    ///         two-valued flag: it says practice-or-not, so a spot fight and an
    ///         events fight both report false. Events desks also live at fresh
    ///         addresses every few minutes, so no fixed table can name them.
    ///         `startDuel` records the set per duel for exactly this reason —
    ///         and until now nothing outside the contract could read it, which
    ///         left every client guessing from the flag and landing on the spot
    ///         pools for an events fight.
    function duelPoolsOf(uint256 duelId) external view returns (address[3] memory) {
        return _duelPools(duelId);
    }

    /// @notice Whether turns are driven by Reactivity, which block the live
    ///         subscription is aimed at, and its id. Zero for `armedFor` and `subId`
    ///         while `on` is true means the chain has stopped — the one failure a
    ///         one-shot subscription cannot recover from by itself.
    ///
    ///         A view rather than three public variables because the router's
    ///         compiled getters are frozen and it is never redeployed.
    function reactivityStatus() external view returns (bool on, uint64 armedFor, uint256 subId, uint64 nextDue) {
        return (reactivityOn, armedForBlock, subscriptionId, _nextTurnBlock());
    }

    /// @notice Returns the minimum USDso deposit (excluding platform fee) for a turn
    ///         tier on the REAL pool set. Kept for backward compatibility.
    function minDepositFor(uint16 turns) external view returns (uint256) {
        return ArenaUtils.minDepositFor(turns, POOL_WETH, POOL_WBTC, POOL_SOMI, poolMeta);
    }

    /// @notice Minimum USDso deposit for a turn tier on the chosen market (real or
    ///         simulated). Matchmaker uses this so simulated queues price correctly.
    function minDepositForMarket(uint16 turns, bool simulated) external view returns (uint256) {
        ArenaTypes.MarketKind kind = simulated
            ? ArenaTypes.MarketKind.Practice : ArenaTypes.MarketKind.Spot;
        address[3] memory mp = _poolsFor(kind);
        return ArenaUtils.minDepositFor(turns, kind, mp[0], mp[1], mp[2], poolMeta);
    }

    /// @notice The exact prompt and allowed action list a fighter would be asked
    ///         with right now, without spending an inference.
    ///
    ///         Exposed because the central guarantee of the prompt layer — that no
    ///         digit reaches the model, so nothing can be extracted and clamped into
    ///         a trade the fighter cannot make — is otherwise unobservable until a
    ///         duel is already running and the STT is already spent.
    function previewTurnPrompt(uint256 duelId, uint8 fighterId)
        external view returns (string memory prompt, string[] memory allowed)
    {
        address[3] memory mp = _duelPools(duelId);
        prompt = ArenaUtils.buildMarketSummary(
            duelId, fighterId, duels[duelId],
            mp[0], mp[1], mp[2], USDSO,
            fighterBalances, poolMeta, duelMarkSnapshots, duelPrevMarkSnapshots, duelOpenMarkSnapshots, poolLabel, poolIsPerp
        );
        allowed = ArenaUtils.actionNames(ArenaUtils.legalActions(
            duelId, fighterId, duels[duelId], mp[0], mp[1], mp[2], USDSO, fighterBalances, poolMeta, poolIsPerp
        ), ArenaUtils.vocabFor(mp, poolLabel, poolIsPerp));
    }

    /// @notice Minimum USDso deposit for a turn tier on the event-contract set.
    ///
    ///         Exists so a lobby can price an event fight before one is started.
    ///         The other two views cover the real and simulated sets only, which
    ///         left the cheapest market the one nobody could quote.
    function minDepositForEvent(uint16 turns) external view returns (uint256) {
        address[3] memory mp = _eventPools();
        return ArenaUtils.minDepositFor(
            turns, ArenaTypes.MarketKind.Events, mp[0], mp[1], mp[2], poolMeta);
    }

    /// @notice Minimum USDso deposit for a turn tier on any of the three markets.
    ///         One call the lobby can use for every row of its menu, instead of a
    ///         different function per market.
    function minDepositForKind(uint16 turns, uint8 marketKind) external view returns (uint256) {
        if (marketKind > uint8(ArenaTypes.MarketKind.Perps)) revert ArenaTypes.InvalidMarketKind();
        ArenaTypes.MarketKind kind = ArenaTypes.MarketKind(marketKind);
        // Perps is priced from a fixed ladder and reads no book, so it must not go
        // through _poolsFor — which deliberately reverts for Perps, because the three
        // markets a fight gets are chosen per fight and there is no set to look up.
        if (kind == ArenaTypes.MarketKind.Perps) {
            return ArenaUtils.minDepositFor(turns, kind, address(0), address(0), address(0), poolMeta);
        }
        address[3] memory mp = _poolsFor(kind);
        return ArenaUtils.minDepositFor(turns, kind, mp[0], mp[1], mp[2], poolMeta);
    }

    /// @notice The question a pool asks, or empty if it is an ordinary asset.
    ///
    ///         Lives here rather than being a public variable because the router is
    ///         never redeployed, so it has no compiled getter for anything appended
    ///         to storage after it shipped.
    function poolQuestion(address pool) external view returns (bytes8) {
        return poolLabel[pool];
    }

    // ─── Perps ───────────────────────────────────────────────────────────────
    //
    // These are views for the same reason `reactivityStatus` and `poolQuestion` are:
    // the router is never redeployed, so nothing appended to storage after it shipped
    // has a compiled getter on it. A `public` variable would produce one on every
    // freshly built part and none on the live router, which is worse than having none
    // at all — the deploy script would decline to route a selector the live router
    // cannot answer.

    /// @notice How perps is wired: the account registry, and whether it is usable.
    function perpStatus() external view returns (bool ready, address registry) {
        return (perpDesksSet && perpRegistry != address(0), perpRegistry);
    }

    /// @notice Whether an address is one of the registered perp desks. Worth being
    ///         able to ask directly: it is what decides whether a slot is scored on
    ///         equity or on cash-plus-holdings, and whether a fighter may sell
    ///         something it does not own.
    function isPerpPool(address pool) external view returns (bool) {
        return poolIsPerp[pool];
    }

    /// @notice The three markets a perps fight at this tier would be offered if it
    ///         started now.
    ///
    ///         Exists because on this market the answer genuinely changes. The other
    ///         three markets have fixed pool sets a lobby can hard-code; here the set
    ///         is computed from what the tier's budget affords against live margin
    ///         factors, so Bitcoin appears in the top tier only while its
    ///         open-interest-scaled factor leaves room for it. A lobby that cannot ask
    ///         this can only guess, and would show a menu that is quietly wrong.
    ///
    /// @dev    Reverts `NotEnoughPerpMarkets` when fewer than three qualify, which is
    ///         the same answer `startDuelOn` would give — better that a lobby sees it
    ///         before a player pays than after.
    function perpMarketsFor(uint16 turns) external view returns (address[3] memory) {
        return _selectPerpPools(ArenaUtils.perpBudget(turns), nextDuelId);
    }

    /// @notice What one fighter is given on a perps fight at this tier, in USDso.
    ///         Fixed and advertised — it reads no book and cannot move between the
    ///         moment a lobby quotes it and the moment a player pays.
    function perpBudgetFor(uint16 turns) external pure returns (uint256) {
        return ArenaUtils.perpBudget(turns);
    }

    /// @notice A perps fighter's live score, its last recorded score, and its trading
    ///         address.
    ///
    ///         `live` false means the oracle could not be read just now, in which case
    ///         `snapshot` is what a finalize at this moment would use. Both are
    ///         returned rather than one resolved number so a client can tell a fighter
    ///         that is genuinely flat from a market that is momentarily unreadable.
    function perpPositionOf(uint256 duelId, uint8 fighterId)
        external view
        returns (bool live, int256 equity, uint256 snapshot, address account, uint8 marginStatus)
    {
        snapshot = perpEquitySnapshots[duelId][fighterId];
        if (perpRegistry == address(0)) return (false, 0, snapshot, address(0), 0);
        IPerpRegistry reg = IPerpRegistry(perpRegistry);
        account = reg.accountOf(duelId, fighterId);
        try reg.equityOf(duelId, fighterId) returns (bool ok, int256 e) {
            live = ok;
            equity = e;
        } catch {}
        try IPerpRegistryStatus(perpRegistry).marginStatusOf(duelId, fighterId) returns (uint8 s) {
            marginStatus = s;
        } catch {}
    }
}

/// @dev Split out so `IPerps.IPerpRegistry` stays the narrow slice Arena's write
///      paths call, and this read stays where it is used.
interface IPerpRegistryStatus {
    function marginStatusOf(uint256 duelId, uint8 fighterId) external view returns (uint8);
}
