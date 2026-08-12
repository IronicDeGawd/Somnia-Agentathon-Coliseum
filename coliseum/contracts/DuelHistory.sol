// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IDuelHistory.sol";

/// @title DuelHistory
/// @notice Canonical on-chain record of resolved duels: per-fighter
///         win/loss/PnL aggregates plus an append-only ledger. Written ONLY by
///         the Arena, which calls onResolved() from _resolveDuel (best-effort —
///         a revert here never blocks duel resolution). Read by the frontend
///         leaderboard / fighter dossier / settled-duel ledger.
contract DuelHistory is IDuelHistory {

    /// @notice Number of fighters in the registry (indexes 0..FIGHTER_COUNT-1).
    uint8 public constant FIGHTER_COUNT = 6;

    /// @notice `winnerSlot` value meaning the duel ended level. Mirrors
    ///         ArenaTypes.DRAW_SLOT; kept local so this sink stays independent of
    ///         the Arena libraries, as ARENA_STATUS constants already are elsewhere.
    uint8 public constant DRAW_SLOT = 2;

    struct FighterRecord {
        uint32 wins;
        uint32 losses;
        uint32 draws;
        uint32 duels;
        int256 cumulativePnl;   // Σ (finalValue − initialPerFighter), USDso wei
    }

    struct Entry {
        uint256 duelId;
        uint8   fighterA;
        uint8   fighterB;
        uint8   winnerSlot;     // 0 = fighterA slot won, 1 = fighterB slot won
        uint8   winnerFighter;  // registry index of the winning fighter
        uint256 valueA;
        uint256 valueB;
        int256  pnlA;
        int256  pnlB;
        uint64  blockNumber;
    }

    /// @notice The only address allowed to write records.
    ///
    ///         Mutable on purpose. This was immutable, which meant every Arena
    ///         redeploy orphaned the ledger and reset the leaderboard to zero —
    ///         the record of every duel ever fought, gone for a contract upgrade.
    ///         setArena lets the history outlive the Arena it records.
    address public arena;

    /// @notice May re-point `arena`. Fixed at deployment.
    address public immutable owner;

    mapping(uint8 => FighterRecord) private _records;
    mapping(uint256 => bool) public recorded;            // duelId => already recorded
    Entry[] private _ledger;
    mapping(uint8 => uint256[]) private _fighterEntryIdx; // fighter index => ledger positions

    error OnlyArena();
    error OnlyOwner();
    error ZeroArena();
    error AlreadyRecorded(uint256 duelId);
    error BadFighterIndex(uint8 index);
    error BadWinnerSlot(uint8 slot);
    error ValueTooLarge();

    event DuelRecorded(
        uint256 indexed duelId,
        uint8   indexed winnerFighter,
        uint8   fighterA,
        uint8   fighterB,
        int256  pnlA,
        int256  pnlB
    );

    /// @notice Emitted when the writer is re-pointed at a new Arena.
    event ArenaSet(address indexed previous, address indexed current);

    constructor(address _arena) {
        arena = _arena;
        owner = msg.sender;
    }

    modifier onlyArena() {
        if (msg.sender != arena) revert OnlyArena();
        _;
    }

    /// @notice Point the ledger at a new Arena so the leaderboard survives an
    ///         upgrade. Past entries are untouched; only who may write changes.
    ///
    ///         The owner can therefore authorise an arbitrary writer. That is the
    ///         same trust already granted by Arena.setDuelHistory, and the
    ///         alternative — an immutable writer — has already cost one full
    ///         history reset.
    function setArena(address a) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (a == address(0)) revert ZeroArena();
        emit ArenaSet(arena, a);
        arena = a;
    }

    /// @inheritdoc IDuelHistory
    function onResolved(
        uint256 duelId,
        uint8 fighterA,
        uint8 fighterB,
        uint8 winnerSlot,
        uint256 valueA,
        uint256 valueB,
        uint256 initialPerFighter
    ) external onlyArena {
        if (recorded[duelId]) revert AlreadyRecorded(duelId);
        if (fighterA >= FIGHTER_COUNT) revert BadFighterIndex(fighterA);
        if (fighterB >= FIGHTER_COUNT) revert BadFighterIndex(fighterB);
        if (winnerSlot > 1 && winnerSlot != DRAW_SLOT) revert BadWinnerSlot(winnerSlot);
        // Solidity does not bounds-check uint256→int256 casts; a value ≥ 2^255
        // would silently flip sign and corrupt PnL. Reject explicitly. (Portfolio
        // values are USDso-denominated and never approach this in practice.)
        if (
            valueA > uint256(type(int256).max) ||
            valueB > uint256(type(int256).max) ||
            initialPerFighter > uint256(type(int256).max)
        ) revert ValueTooLarge();
        recorded[duelId] = true;

        int256 init = int256(initialPerFighter);
        int256 pnlA = int256(valueA) - init;
        int256 pnlB = int256(valueB) - init;
        bool   isDraw = winnerSlot == DRAW_SLOT;
        // 255 = nobody won. Mirrors the sentinel Arena emits in DuelResolved.
        uint8  winnerFighter = isDraw
            ? type(uint8).max
            : (winnerSlot == 0 ? fighterA : fighterB);

        // ── Aggregates ──────────────────────────────────────────────────────
        FighterRecord storage ra = _records[fighterA];
        FighterRecord storage rb = _records[fighterB];
        ra.duels += 1;
        rb.duels += 1;
        ra.cumulativePnl += pnlA;
        rb.cumulativePnl += pnlB;
        if (isDraw) {
            ra.draws += 1;
            rb.draws += 1;
        } else if (winnerSlot == 0) {
            ra.wins   += 1;
            rb.losses += 1;
        } else {
            rb.wins   += 1;
            ra.losses += 1;
        }

        // ── Ledger ──────────────────────────────────────────────────────────
        uint256 idx = _ledger.length;
        _ledger.push(Entry({
            duelId:        duelId,
            fighterA:      fighterA,
            fighterB:      fighterB,
            winnerSlot:    winnerSlot,
            winnerFighter: winnerFighter,
            valueA:        valueA,
            valueB:        valueB,
            pnlA:          pnlA,
            pnlB:          pnlB,
            blockNumber:   uint64(block.number)
        }));
        _fighterEntryIdx[fighterA].push(idx);
        if (fighterB != fighterA) _fighterEntryIdx[fighterB].push(idx);

        emit DuelRecorded(duelId, winnerFighter, fighterA, fighterB, pnlA, pnlB);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    function getFighterRecord(uint8 index) external view returns (FighterRecord memory) {
        return _records[index];
    }

    /// @notice Records for all FIGHTER_COUNT fighters; array position == fighter index.
    function leaderboard() external view returns (FighterRecord[] memory out) {
        out = new FighterRecord[](FIGHTER_COUNT);
        for (uint8 i = 0; i < FIGHTER_COUNT; i++) {
            out[i] = _records[i];
        }
    }

    /// @notice Total number of settled duels recorded.
    function totalDuels() external view returns (uint256) {
        return _ledger.length;
    }

    /// @notice Paginated global ledger (oldest-first). offset/limit are clamped.
    function getEntries(uint256 offset, uint256 limit) external view returns (Entry[] memory out) {
        uint256 len = _ledger.length;
        if (offset >= len || limit == 0) return new Entry[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        out = new Entry[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = _ledger[i];
        }
    }

    /// @notice Paginated ledger for a single fighter (oldest-first).
    function getFighterEntries(uint8 index, uint256 offset, uint256 limit)
        external
        view
        returns (Entry[] memory out)
    {
        uint256[] storage idxs = _fighterEntryIdx[index];
        uint256 len = idxs.length;
        if (offset >= len || limit == 0) return new Entry[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        out = new Entry[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = _ledger[idxs[i]];
        }
    }

    function fighterEntryCount(uint8 index) external view returns (uint256) {
        return _fighterEntryIdx[index].length;
    }
}
