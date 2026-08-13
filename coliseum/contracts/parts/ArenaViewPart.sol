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

    /// @notice Returns the minimum USDso deposit (excluding platform fee) for a turn
    ///         tier on the REAL pool set. Kept for backward compatibility.
    function minDepositFor(uint16 turns) external view returns (uint256) {
        return ArenaUtils.minDepositFor(turns, POOL_WETH, POOL_WBTC, POOL_SOMI, poolMeta);
    }

    /// @notice Minimum USDso deposit for a turn tier on the chosen market (real or
    ///         simulated). Matchmaker uses this so simulated queues price correctly.
    function minDepositForMarket(uint16 turns, bool simulated) external view returns (uint256) {
        address[3] memory mp = _pools(simulated);
        return ArenaUtils.minDepositFor(turns, mp[0], mp[1], mp[2], poolMeta);
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
            fighterBalances, poolMeta, duelMarkSnapshots, duelPrevMarkSnapshots
        );
        allowed = ArenaUtils.actionNames(ArenaUtils.legalActions(
            duelId, fighterId, duels[duelId], mp[0], mp[1], mp[2], fighterBalances, poolMeta
        ));
    }
}
