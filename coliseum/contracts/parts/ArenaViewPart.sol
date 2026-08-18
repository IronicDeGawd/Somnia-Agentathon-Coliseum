// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ArenaStorage.sol";
import "../lib/ArenaTypes.sol";
import "../lib/ArenaUtils.sol";

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
            mp[0], mp[1], mp[2],
            fighterBalances, poolMeta, duelMarkSnapshots, duelPrevMarkSnapshots, poolLabel
        );
        allowed = ArenaUtils.actionNames(ArenaUtils.legalActions(
            duelId, fighterId, duels[duelId], mp[0], mp[1], mp[2], fighterBalances, poolMeta
        ), ArenaUtils.vocabFor(mp, poolLabel));
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
        if (marketKind > uint8(ArenaTypes.MarketKind.Events)) revert ArenaTypes.InvalidMarketKind();
        ArenaTypes.MarketKind kind = ArenaTypes.MarketKind(marketKind);
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
}
