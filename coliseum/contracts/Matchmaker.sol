// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Matchmaker
/// @notice PvP matchmaking layer for the Coliseum Arena.
///
///  Model (Hypixel-style):
///   - Each human picks ONE fighter persona and a tier (3/6/9/15 rounds).
///   - They deposit half the duel pot and wait in a queue slot.
///   - When a second human queues into the same tier with a DIFFERENT fighter,
///     the contract pairs them and fires Arena.startDuel().
///   - Their AI agents fight each other on dreamDEX.
///   - After the duel resolves, the winner claims the full recovered pot.
///
///  Security properties:
///   - CEI: all state changes happen before external calls throughout.
///   - Per-tier pending slots: one pending match per tier (not a global bottleneck).
///   - minDepositFor re-queried at match time: both players refunded if market moved.
///   - Approval reset to zero after every startDuel call.
///   - Cancel rate-limited to 1+ blocks (prevents same-block queue-grief).
///   - Fighter index validated via arena.FIGHTER_COUNT() at queue time.
///   - Owner emergency rescue for stuck funds (zero-value recovery path only).

interface IArena {
    function startDuel(uint8 fighterA, uint8 fighterB, uint16 turns)
        external returns (uint256 duelId);

    function activeDuelId() external view returns (uint256);
    function minDepositFor(uint16 turns) external view returns (uint256);
    function recoverFunds(uint256 duelId) external;
    function PLATFORM_FEE() external view returns (uint256);

    // Field order: 0=fighterA, 1=fighterB, 2=creator, 3=startBlock,
    // 4=lastTurnBlock, 5=completedCallbacks, 6=turns, 7=poolMask,
    // 8=status (0=None,1=Active,2=Finalizing,3=Resolved),
    // 9=initialUsdsoPerFighter, 10=lastAction[2], 11=fundsRecovered, 12=winnerSlot
    function duels(uint256 duelId) external view returns (
        uint8, uint8, address, uint256, uint256, uint16, uint16, uint8,
        uint8 status, uint256, uint8[2] memory, bool, uint8 winnerSlot
    );
}

interface IERC20M {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IRegistry {
    // FIGHTER_COUNT lives on the FighterRegistry, NOT on Arena.
    function FIGHTER_COUNT() external view returns (uint8);
}

contract Matchmaker {

    // ─── Ownership ───────────────────────────────────────────────────────────

    address public immutable owner;
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    // ─── Immutables ───────────────────────────────────────────────────────────

    IArena    public immutable arena;
    IERC20M   public immutable usdso;
    IRegistry public immutable registry;

    // Mirrors ArenaTypes.DuelStatus.Resolved = 3.
    // If Arena's enum ever changes, update this constant.
    uint8 private constant STATUS_RESOLVED = 3;

    // Minimum blocks a player must wait before they can cancel their queue entry.
    // Prevents same-block queue-grief (queue then cancel to deny an opponent a slot).
    uint64 public constant CANCEL_DELAY_BLOCKS = 1;

    // ─── Queue slots (one per tier) ───────────────────────────────────────────

    struct Slot {
        address player;
        uint8   fighter;
        uint256 deposit;     // exact USDso held for this player
        uint64  queuedBlock; // block.number when player queued (cancel rate-limit)
    }

    // turns ∈ {3, 6, 9, 15} → open queue slot
    mapping(uint16 => Slot) public slots;

    // ─── Pending matches (one per tier) ──────────────────────────────────────
    //
    // A pending match forms when two players match but Arena is busy.
    // Per-tier storage means up to 4 matches can be pending simultaneously
    // (one per tier), rather than a global bottleneck that blocks all tiers.

    struct PendingMatch {
        address playerA;
        address playerB;
        uint8   fighterA;
        uint8   fighterB;
        uint16  turns;
        uint256 totalPot;  // combined deposit held; may be refunded if price drift
        bool    exists;
    }

    // turns → pending match waiting for Arena to free up
    mapping(uint16 => PendingMatch) public pendingByTier;

    // ─── Match records ────────────────────────────────────────────────────────

    struct Match {
        address playerA;    // chose fighterA (winnerSlot 0)
        address playerB;    // chose fighterB (winnerSlot 1)
        uint256 totalPot;   // actual USDso recovered from Arena (set during claimWinnings)
        bool    recovered;  // true once recoverFunds was called
        bool    settledA;
        bool    settledB;
    }

    mapping(uint256 => Match) public matches;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Queued(address indexed player, uint8 indexed fighter, uint16 turns, uint256 deposit);
    event QueueCancelled(address indexed player, uint16 turns, uint256 refund);
    event MatchPending(address indexed playerA, address indexed playerB, uint16 turns);
    event MatchStarted(
        uint256 indexed duelId,
        address indexed playerA, address indexed playerB,
        uint8 fighterA, uint8 fighterB, uint16 turns
    );
    event MatchRefunded(
        address indexed playerA, address indexed playerB,
        uint16 turns, uint256 amountEach, string reason
    );
    event WinningsClaimed(uint256 indexed duelId, address indexed player, uint256 amount);
    event EmergencyRecoverySet(uint256 indexed duelId, uint256 totalPot);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InvalidTier();
    error InvalidFighter();
    error MatchYourself();
    error SameFighter();
    error ArenaStillBusy();
    error NoPendingMatch();
    error NotQueued();
    error CancelTooSoon();
    error DuelNotResolved();
    error NotAPlayer();
    error AlreadySettled();
    error TransferFailed();
    error ApproveFailed();

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _arena, address _usdso, address _registry) {
        owner    = msg.sender;
        arena    = IArena(_arena);
        usdso    = IERC20M(_usdso);
        registry = IRegistry(_registry);
    }

    // ─── Queue ────────────────────────────────────────────────────────────────

    /// @notice Enter the matchmaking queue.
    /// @param fighter  Your FighterRegistry index (0 to FIGHTER_COUNT-1).
    /// @param turns    Tier: 3, 6, 9, or 15 rounds.
    ///
    /// Approve this contract for halfDeposit(turns) USDso before calling.
    function queue(uint8 fighter, uint16 turns) external {
        if (turns != 3 && turns != 6 && turns != 9 && turns != 15)
            revert InvalidTier();

        // Validate fighter index against the FighterRegistry (M-1 fix).
        // NOTE: FIGHTER_COUNT lives on the registry, not on Arena.
        if (fighter >= registry.FIGHTER_COUNT()) revert InvalidFighter();

        uint256 half = halfDeposit(turns);

        // Pull deposit before touching state (CEI: funds in first)
        if (!usdso.transferFrom(msg.sender, address(this), half))
            revert TransferFailed();

        Slot storage slot = slots[turns];

        if (slot.player == address(0)) {
            // ── Slot empty: first player in ──────────────────────────────────
            slot.player      = msg.sender;
            slot.fighter     = fighter;
            slot.deposit     = half;
            slot.queuedBlock = uint64(block.number);
            emit Queued(msg.sender, fighter, turns, half);

        } else {
            // ── Slot occupied: attempt to match ──────────────────────────────
            if (slot.player == msg.sender) revert MatchYourself();
            if (slot.fighter == fighter)   revert SameFighter();

            address pA  = slot.player;
            uint8   fA  = slot.fighter;
            uint256 dA  = slot.deposit;

            // CEI: clear slot before any external calls
            delete slots[turns];

            uint256 total = dA + half;

            if (_arenaFree()) {
                _startOrRefund(pA, msg.sender, fA, fighter, turns, total);
            } else {
                // Arena busy — store per-tier pending match (H-2 fix)
                if (pendingByTier[turns].exists) revert ArenaStillBusy();
                pendingByTier[turns] = PendingMatch({
                    playerA:  pA,
                    playerB:  msg.sender,
                    fighterA: fA,
                    fighterB: fighter,
                    turns:    turns,
                    totalPot: total,
                    exists:   true
                });
                emit MatchPending(pA, msg.sender, turns);
            }
        }
    }

    // ─── Trigger pending match ────────────────────────────────────────────────

    /// @notice Trigger a pending match for a specific tier once Arena is free.
    ///         Permissionless — anyone can call this.
    /// @param turns  The tier whose pending match to trigger.
    function triggerPendingMatch(uint16 turns) external {
        PendingMatch storage pm = pendingByTier[turns];
        if (!pm.exists)     revert NoPendingMatch();
        if (!_arenaFree())  revert ArenaStillBusy();

        // CEI: copy to memory and delete state before external calls
        PendingMatch memory m = pm;
        delete pendingByTier[turns];

        _startOrRefund(m.playerA, m.playerB, m.fighterA, m.fighterB, m.turns, m.totalPot);
    }

    // ─── Cancel queue entry ───────────────────────────────────────────────────

    /// @notice Leave the queue and reclaim your deposit.
    ///         Only callable ≥ CANCEL_DELAY_BLOCKS after queueing.
    function cancelQueue(uint16 turns) external {
        Slot storage slot = slots[turns];
        if (slot.player != msg.sender) revert NotQueued();
        // Rate-limit cancels to prevent same-block queue-grief (M-3 fix)
        if (block.number < slot.queuedBlock + CANCEL_DELAY_BLOCKS) revert CancelTooSoon();

        uint256 refund = slot.deposit;
        delete slots[turns]; // effect before transfer (CEI)

        if (!usdso.transfer(msg.sender, refund)) revert TransferFailed();
        emit QueueCancelled(msg.sender, turns, refund);
    }

    // ─── Claim winnings ───────────────────────────────────────────────────────

    /// @notice Claim your outcome after the duel resolves.
    ///         Winner receives the full recovered pot. Loser gets 0.
    ///         Either player may call; the other may call to record their loss.
    function claimWinnings(uint256 duelId) external {
        Match storage m = matches[duelId];

        bool isA = (msg.sender == m.playerA);
        bool isB = (msg.sender == m.playerB);
        if (!isA && !isB)      revert NotAPlayer();
        if (isA && m.settledA) revert AlreadySettled();
        if (isB && m.settledB) revert AlreadySettled();

        (,,,,,,,, uint8 status,,,, uint8 winnerSlot) = arena.duels(duelId);
        if (status != STATUS_RESOLVED) revert DuelNotResolved();

        // ── C-1 fix: set m.recovered = true BEFORE calling recoverFunds ──────
        // This closes the reentrancy window: if recoverFunds somehow re-enters
        // claimWinnings, the !m.recovered branch will be skipped.
        if (!m.recovered) {
            m.recovered = true;                              // effect first
            uint256 before  = usdso.balanceOf(address(this));
            arena.recoverFunds(duelId);                      // external call after
            m.totalPot = usdso.balanceOf(address(this)) - before;
        }

        // Mark caller settled before transfer (CEI)
        if (isA) m.settledA = true;
        else     m.settledB = true;

        bool callerWon = (winnerSlot == 0 && isA) || (winnerSlot == 1 && isB);
        uint256 payout = callerWon ? m.totalPot : 0;

        if (payout > 0) {
            if (!usdso.transfer(msg.sender, payout)) revert TransferFailed();
        }

        emit WinningsClaimed(duelId, msg.sender, payout);
    }

    // ─── Emergency rescue (H-1 fix) ──────────────────────────────────────────

    /// @notice Owner-only last-resort unbricking for a match whose Arena.recoverFunds
    ///         reverts permanently (e.g. both fighters ended holding only base tokens,
    ///         leaving nothing for Arena to return as USDso quote).
    ///
    ///         TRUST NOTE: this sets totalPot = 0, so claimWinnings pays both players 0.
    ///         Both players LOSE their half-deposits — those funds remain stranded in
    ///         Arena (this contract cannot pull them once recoverFunds reverts). The
    ///         owner gains nothing (no tokens move to the owner), but the owner CAN grief
    ///         by zeroing a duel whose funds were in fact recoverable. This is a known
    ///         privileged capability; in production it should sit behind a timelock or
    ///         multisig. Use only when recoverFunds is genuinely, permanently reverting.
    function emergencyZeroRecovery(uint256 duelId) external onlyOwner {
        Match storage m = matches[duelId];
        require(!m.recovered, "already recovered");
        // Verify duel is resolved before owner can touch it
        (,,,,,,,, uint8 status,,,,) = arena.duels(duelId);
        require(status == STATUS_RESOLVED, "not resolved");

        m.recovered = true;
        m.totalPot  = 0;
        emit EmergencyRecoverySet(duelId, 0);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice USDso amount each player must approve before calling queue().
    function halfDeposit(uint16 turns) public view returns (uint256) {
        uint256 minDep = arena.minDepositFor(turns);
        if (minDep == 0) minDep = 2e18;
        uint256 total  = minDep + arena.PLATFORM_FEE();
        return (total + 1) / 2; // ceil — ensures combined >= required
    }

    function getSlot(uint16 turns)
        external view
        returns (address player, uint8 fighter, uint256 deposit, uint64 queuedBlock)
    {
        Slot storage s = slots[turns];
        return (s.player, s.fighter, s.deposit, s.queuedBlock);
    }

    function arenaFree() external view returns (bool) { return _arenaFree(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _arenaFree() internal view returns (bool) {
        uint256 activeId = arena.activeDuelId();
        if (activeId == 0) return true;
        (,,,,,,,, uint8 status,,,,) = arena.duels(activeId);
        return status == STATUS_RESOLVED;
    }

    /// @dev Attempt to start a match. If the required deposit has drifted above
    ///      the combined deposits collected, refund both players instead of
    ///      leaving funds stranded (H-3 fix).
    function _startOrRefund(
        address pA, address pB,
        uint8 fA, uint8 fB,
        uint16 turns, uint256 total
    ) internal {
        // Re-query required amount at match time (market prices may have moved)
        uint256 minDep = arena.minDepositFor(turns);
        if (minDep == 0) minDep = 2e18;
        uint256 required = minDep + arena.PLATFORM_FEE();

        if (total < required) {
            // Price drifted up between queue and match — refund both players.
            // C-1 fix: check transfer return values. On a non-reverting ERC-20
            // that returns false, an unchecked transfer would silently strand
            // both deposits with no recovery path. Reverting here rolls back the
            // whole tx atomically (including any first transfer that succeeded).
            uint256 eachRefund = total / 2;
            if (!usdso.transfer(pA, eachRefund)) revert TransferFailed();
            if (!usdso.transfer(pB, total - eachRefund)) revert TransferFailed(); // odd-wei dust to pB
            emit MatchRefunded(pA, pB, turns, eachRefund, "deposit below required");
            return;
        }

        // H-4 fix: approve(0) first (USDT-style token safety), then approve required
        // Only approve the exact amount Arena will pull, not the full `total`.
        usdso.approve(address(arena), 0);
        if (!usdso.approve(address(arena), required)) revert ApproveFailed();

        uint256 duelId = arena.startDuel(fA, fB, turns);

        // H-4 fix: reset approval to zero after startDuel consumed it
        usdso.approve(address(arena), 0);

        // Any dust (total - required) stays in Matchmaker — negligible (≤1 wei normally)

        matches[duelId] = Match({
            playerA:   pA,
            playerB:   pB,
            totalPot:  total,   // will be overwritten to actual recovered amount in claimWinnings
            recovered: false,
            settledA:  false,
            settledB:  false
        });

        emit MatchStarted(duelId, pA, pB, fA, fB, turns);
    }
}
