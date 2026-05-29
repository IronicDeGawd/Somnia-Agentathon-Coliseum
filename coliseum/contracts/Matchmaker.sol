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
///  Queue model (v1): one open slot per tier.
///   - If the slot is empty: caller takes it, deposit is held.
///   - If the slot has a different fighter: instant match → Arena.startDuel().
///   - If Arena is busy (another duel running): match is queued as pending.
///     Anyone can call triggerPendingMatch() once Arena becomes free.
///   - If the slot has the SAME fighter: revert (same fighter not allowed).
///
///  Deposit accounting:
///   - Each player pays ceil((minDepositFor(turns) + PLATFORM_FEE) / 2).
///   - Combined total >= Arena's required amount. Dust (≤1 wei) stays in contract.
///   - After resolution, Matchmaker calls Arena.recoverFunds() and pays the winner.
///   - Loser gets 0. The pot is winner-takes-all (matching Arena semantics).

interface IArena {
    function startDuel(uint8 fighterA, uint8 fighterB, uint16 turns)
        external returns (uint256 duelId);

    function activeDuelId() external view returns (uint256);

    function minDepositFor(uint16 turns) external view returns (uint256);

    function recoverFunds(uint256 duelId) external;

    function PLATFORM_FEE() external view returns (uint256);

    // Returns the full Duel struct as a tuple.
    // Field order matches ArenaTypes.Duel:
    //   0 fighterA, 1 fighterB, 2 creator, 3 startBlock, 4 lastTurnBlock,
    //   5 completedCallbacks, 6 turns, 7 poolMask, 8 status (uint8),
    //   9 initialUsdsoPerFighter, 10 lastAction (uint8[2]),
    //   11 fundsRecovered, 12 winnerSlot
    function duels(uint256 duelId) external view returns (
        uint8   fighterA,
        uint8   fighterB,
        address creator,
        uint256 startBlock,
        uint256 lastTurnBlock,
        uint16  completedCallbacks,
        uint16  turns,
        uint8   poolMask,
        uint8   status,
        uint256 initialUsdsoPerFighter,
        uint8[2] memory lastAction,
        bool    fundsRecovered,
        uint8   winnerSlot
    );
}

interface IERC20M {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract Matchmaker {

    // ─── Immutables ───────────────────────────────────────────────────────────

    IArena  public immutable arena;
    IERC20M public immutable usdso;

    // DuelStatus.Resolved = 3 (mirrors ArenaTypes.DuelStatus enum)
    uint8 private constant STATUS_RESOLVED = 3;

    // ─── Queue slots (one per tier) ───────────────────────────────────────────

    struct Slot {
        address player;
        uint8   fighter;
        uint256 deposit; // exact USDso held in this contract for this player
    }

    // turns ∈ {3, 6, 9, 15} → open queue slot
    mapping(uint16 => Slot) public slots;

    // ─── Pending match (waiting for Arena to free up) ─────────────────────────

    struct PendingMatch {
        address playerA;
        address playerB;
        uint8   fighterA;
        uint8   fighterB;
        uint16  turns;
        uint256 totalPot;
        bool    exists;
    }

    PendingMatch public pending;

    // ─── Match records ────────────────────────────────────────────────────────

    struct Match {
        address playerA;    // chose fighterA (winnerSlot 0)
        address playerB;    // chose fighterB (winnerSlot 1)
        uint256 totalPot;   // combined USDso sent to Arena (updated after recoverFunds)
        bool    recovered;  // true once recoverFunds was called
        bool    settledA;
        bool    settledB;
    }

    // duelId → match record
    mapping(uint256 => Match) public matches;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Queued(
        address indexed player,
        uint8   indexed fighter,
        uint16  turns,
        uint256 deposit
    );
    event QueueCancelled(address indexed player, uint16 turns, uint256 refund);
    event MatchPending(
        address indexed playerA,
        address indexed playerB,
        uint16  turns
    );
    event MatchStarted(
        uint256 indexed duelId,
        address indexed playerA,
        address indexed playerB,
        uint8   fighterA,
        uint8   fighterB,
        uint16  turns
    );
    event WinningsClaimed(
        uint256 indexed duelId,
        address indexed player,
        uint256 amount
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InvalidTier();
    error MatchYourself();
    error SameFighter();
    error SlotAlreadyYours();
    error ArenaStillBusy();
    error NoPendingMatch();
    error NotQueued();
    error DuelNotResolved();
    error NotAPlayer();
    error AlreadySettled();
    error TransferFailed();
    error ApproveFailed();

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _arena, address _usdso) {
        arena = IArena(_arena);
        usdso = IERC20M(_usdso);
    }

    // ─── Queue ────────────────────────────────────────────────────────────────

    /// @notice Enter the matchmaking queue.
    /// @param fighter  Your chosen FighterRegistry index (0–5).
    /// @param turns    Tier: 3, 6, 9, or 15 rounds.
    ///
    /// Caller must have approved this contract for at least halfDeposit(turns).
    /// Call halfDeposit(turns) to know the exact amount before approving.
    function queue(uint8 fighter, uint16 turns) external {
        if (turns != 3 && turns != 6 && turns != 9 && turns != 15)
            revert InvalidTier();

        uint256 half = halfDeposit(turns);

        // Pull deposit from caller
        if (!usdso.transferFrom(msg.sender, address(this), half))
            revert TransferFailed();

        Slot storage slot = slots[turns];

        if (slot.player == address(0)) {
            // ── Slot empty: first player in ──────────────────────────────────
            slot.player  = msg.sender;
            slot.fighter = fighter;
            slot.deposit = half;
            emit Queued(msg.sender, fighter, turns, half);
        } else {
            // ── Slot occupied: attempt to match ──────────────────────────────
            if (slot.player == msg.sender) revert MatchYourself();
            if (slot.fighter == fighter)   revert SameFighter();

            address pA  = slot.player;
            uint8   fA  = slot.fighter;
            uint256 dA  = slot.deposit;

            delete slots[turns]; // clear slot before any external calls (CEI)

            uint256 total = dA + half;

            if (_arenaFree()) {
                _startMatch(pA, msg.sender, fA, fighter, turns, total);
            } else {
                // Arena busy — store match as pending, anyone can trigger later
                // Only one pending match allowed at a time
                if (pending.exists) revert ArenaStillBusy();
                pending = PendingMatch({
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

    /// @notice Trigger a stored pending match now that Arena is free.
    ///         Callable by anyone — permissionless.
    function triggerPendingMatch() external {
        if (!pending.exists)  revert NoPendingMatch();
        if (!_arenaFree())    revert ArenaStillBusy();

        PendingMatch memory m = pending;
        delete pending; // clear before external calls (CEI)

        _startMatch(m.playerA, m.playerB, m.fighterA, m.fighterB, m.turns, m.totalPot);
    }

    // ─── Cancel queue entry ───────────────────────────────────────────────────

    /// @notice Leave the queue and reclaim your deposit.
    ///         Only callable before you've been matched.
    function cancelQueue(uint16 turns) external {
        Slot storage slot = slots[turns];
        if (slot.player != msg.sender) revert NotQueued();

        uint256 refund = slot.deposit;
        delete slots[turns];

        if (!usdso.transfer(msg.sender, refund)) revert TransferFailed();
        emit QueueCancelled(msg.sender, turns, refund);
    }

    // ─── Claim winnings ───────────────────────────────────────────────────────

    /// @notice Claim your outcome after the duel resolves.
    ///         Winner receives the full recovered pot. Loser gets 0.
    ///         Either player may call first; the other may call to confirm loss.
    /// @param duelId  The Arena duel ID returned when the match started.
    function claimWinnings(uint256 duelId) external {
        Match storage m = matches[duelId];

        bool isA = (msg.sender == m.playerA);
        bool isB = (msg.sender == m.playerB);
        if (!isA && !isB)    revert NotAPlayer();
        if (isA && m.settledA) revert AlreadySettled();
        if (isB && m.settledB) revert AlreadySettled();

        (,,,,,,,, uint8 status,,,, uint8 winnerSlot) = arena.duels(duelId);
        if (status != STATUS_RESOLVED) revert DuelNotResolved();

        // Pull funds from Arena on first claim (Matchmaker is the duel creator)
        if (!m.recovered) {
            uint256 before = usdso.balanceOf(address(this));
            arena.recoverFunds(duelId); // reverts if already recovered or not resolved
            uint256 postBal = usdso.balanceOf(address(this));
            m.totalPot  = postBal - before; // actual recovered amount post-trading
            m.recovered = true;
        }

        // Mark caller as settled before transfer (CEI)
        if (isA) m.settledA = true;
        else     m.settledB = true;

        bool callerWon = (winnerSlot == 0 && isA) || (winnerSlot == 1 && isB);

        uint256 payout = callerWon ? m.totalPot : 0;
        if (payout > 0) {
            if (!usdso.transfer(msg.sender, payout)) revert TransferFailed();
        }

        emit WinningsClaimed(duelId, msg.sender, payout);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice How much USDso a player needs to approve before calling queue().
    function halfDeposit(uint16 turns) public view returns (uint256) {
        uint256 minDep = arena.minDepositFor(turns);
        if (minDep == 0) minDep = 2e18; // floor matching Arena (empty order book)
        uint256 total  = minDep + arena.PLATFORM_FEE();
        return (total + 1) / 2; // ceil so combined >= Arena's required
    }

    /// @notice Returns the open queue slot for a given tier, if any.
    function getSlot(uint16 turns)
        external view
        returns (address player, uint8 fighter, uint256 deposit)
    {
        Slot storage s = slots[turns];
        return (s.player, s.fighter, s.deposit);
    }

    /// @notice True if Arena is free to accept a new duel.
    function arenaFree() external view returns (bool) {
        return _arenaFree();
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _arenaFree() internal view returns (bool) {
        uint256 activeId = arena.activeDuelId();
        if (activeId == 0) return true;
        (,,,,,,,, uint8 status,,,,) = arena.duels(activeId);
        return status == STATUS_RESOLVED;
    }

    function _startMatch(
        address pA, address pB,
        uint8 fA, uint8 fB,
        uint16 turns, uint256 total
    ) internal {
        // Approve Arena to pull the combined pot
        if (!usdso.approve(address(arena), total)) revert ApproveFailed();

        uint256 duelId = arena.startDuel(fA, fB, turns);

        matches[duelId] = Match({
            playerA:   pA,
            playerB:   pB,
            totalPot:  total,
            recovered: false,
            settledA:  false,
            settledB:  false
        });

        emit MatchStarted(duelId, pA, pB, fA, fB, turns);
    }
}
