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
    function startDuelOn(uint8 fighterA, uint8 fighterB, uint16 turns, uint8 marketKind)
        external returns (uint256 duelId);

    /// True while Arena can accept another concurrent duel.
    function hasCapacity() external view returns (bool);
    function minDepositFor(uint16 turns) external view returns (uint256);
    function minDepositForKind(uint16 turns, uint8 marketKind) external view returns (uint256);
    function recoverFunds(uint256 duelId) external;
    function platformFee(uint16 turns) external view returns (uint256);

    // Field order: 0=fighterA, 1=fighterB, 2=creator, 3=startBlock,
    // 4=lastTurnBlock, 5=completedCallbacks, 6=turns, 7=poolMask,
    // 8=status (0=None,1=Active,2=Finalizing,3=Resolved),
    // Mirrors Arena's auto-getter: Solidity OMITS the uint8[2] lastAction array
    // from struct getters, so it returns 12 fields (not 13). Indices:
    // 8=status, 9=initialUsdsoPerFighter, 10=fundsRecovered, 11=winnerSlot.
    function duels(uint256 duelId) external view returns (
        uint8, uint8, address, uint256, uint256, uint16, uint16, uint8,
        uint8 status, uint256, bool, uint8 winnerSlot
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

    // Mirrors ArenaTypes.DRAW_SLOT = 2 — the duel ended level and neither player
    // takes the other's stake.
    uint8 private constant DRAW_SLOT = 2;

    // Minimum blocks a player must wait before they can cancel their queue entry.
    // Prevents same-block queue-grief (queue then cancel to deny an opponent a slot).
    uint64 public constant CANCEL_DELAY_BLOCKS = 1;

    // Deposit headroom over the bare required amount. minDepositFor reads the live
    // (thin, volatile) dreamDEX book, so `required` drifts between queue and match.
    // Without headroom the collected total == required exactly and any upward tick
    // refunds the match. We collect 25% extra and refund the unused surplus to both
    // players after the duel starts, so drift can't silently kill a match.
    uint256 public constant DEPOSIT_BUFFER_BPS = 2500;

    // The perps market. Its entry price is a fixed constant rather than a figure read
    // off a book, so it takes no headroom — see `_bufferBpsFor`.
    uint8 private constant KIND_PERPS = 3;

    // ─── Queue slots (one per tier) ───────────────────────────────────────────

    struct Slot {
        address player;
        uint8   fighter;
        uint256 deposit;     // exact USDso held for this player
        uint64  queuedBlock; // block.number when player queued (cancel rate-limit)
    }

    // (turns ∈ {3,6,9,15}, marketKind) → open queue slot. Keying by market as well
    // means a real-market player only ever matches another real-market player.
    mapping(uint16 => mapping(uint8 => Slot)) public slots;

    // ─── Pending matches (FIFO queue per tier + market) ───────────────────────
    //
    // A pending match forms when two players pair up but Arena has no free slot.
    // This used to be a single slot per (tier, market), so the third and fourth
    // players to arrive were turned away with ArenaStillBusy — they had paired
    // successfully and were rejected anyway. It is now a real queue: matches wait
    // in arrival order and start as slots free up.
    //
    // Implemented as head/tail cursors over a mapping rather than an array, so
    // enqueue and dequeue are both O(1) and nothing is ever shifted.

    struct PendingMatch {
        address playerA;
        address playerB;
        uint8   fighterA;
        uint8   fighterB;
        uint16  turns;
        uint256 totalPot;  // combined deposit held; may be refunded if price drift
        bool    exists;    // false once started or cancelled — a tombstone
        uint8   marketKind; // which market this pending match will start on
    }

    // (turns, marketKind, position) → queued match. Positions run head..tail-1.
    mapping(uint16 => mapping(uint8 => mapping(uint256 => PendingMatch))) public pendingQueue;
    mapping(uint16 => mapping(uint8 => uint256)) public pendingHead;
    mapping(uint16 => mapping(uint8 => uint256)) public pendingTail;

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
    /// @notice A queued pair was withdrawn by one of its players; both were refunded.
    event PendingCancelled(uint256 indexed position, address playerA, address playerB, uint16 turns);
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
    error InvalidMarket();
    error InvalidFighter();
    error MatchYourself();
    error SameFighter();
    error ArenaStillBusy();
    error NoPendingMatch();
    error NotYourMatch();
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
    /// @param fighter    Your FighterRegistry index (0 to FIGHTER_COUNT-1).
    /// @param turns      Tier: 3, 6, 9, or 15 rounds.
    /// @param marketKind 0 spot coins, 1 practice, 2 events (three live prediction
    ///        questions), 3 perps (three leveraged futures markets, where a fighter
    ///        may also bet a market DOWN). Queues are kept separate per market, so you
    ///        only ever match someone who chose the same one — the four cost wildly
    ///        different amounts and could not share a pot.
    ///
    /// Approve this contract for halfDeposit(turns, marketKind) USDso first.
    function queue(uint8 fighter, uint16 turns, uint8 marketKind) external {
        if (turns != 3 && turns != 6 && turns != 9 && turns != 15)
            revert InvalidTier();
        // Arena would reject an unknown market anyway, but only after both
        // deposits had been taken and the pair matched.
        if (marketKind > 3) revert InvalidMarket();

        // Validate fighter index against the FighterRegistry (M-1 fix).
        // NOTE: FIGHTER_COUNT lives on the registry, not on Arena.
        if (fighter >= registry.FIGHTER_COUNT()) revert InvalidFighter();

        uint256 half = halfDeposit(turns, marketKind);

        // Pull deposit before touching state (CEI: funds in first)
        if (!usdso.transferFrom(msg.sender, address(this), half))
            revert TransferFailed();

        Slot storage slot = slots[turns][marketKind];

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
            delete slots[turns][marketKind];

            uint256 total = dA + half;

            // Only start immediately when there is a pre-existing queue to skip
            // AND a free Arena slot. Otherwise take a ticket at the back, so a
            // pair that arrives later can never overtake one already waiting.
            if (_arenaFree() && pendingCount(turns, marketKind) == 0) {
                _startOrRefund(pA, msg.sender, fA, fighter, turns, total, marketKind);
            } else {
                uint256 pos = pendingTail[turns][marketKind];
                pendingQueue[turns][marketKind][pos] = PendingMatch({
                    playerA:  pA,
                    playerB:  msg.sender,
                    fighterA: fA,
                    fighterB: fighter,
                    turns:    turns,
                    totalPot: total,
                    exists:   true,
                    marketKind: marketKind
                });
                pendingTail[turns][marketKind] = pos + 1;
                emit MatchPending(pA, msg.sender, turns);
            }
        }
    }

    // ─── Trigger pending match ────────────────────────────────────────────────

    /// @notice Start the pair at the head of a tier's queue, once Arena has a free
    ///         slot. Permissionless — anyone can call this.
    /// @param turns  The tier whose queue head to start.
    function triggerPendingMatch(uint16 turns, uint8 marketKind) external {
        if (!_arenaFree()) revert ArenaStillBusy();

        // Walk past any cancelled entries (tombstones) to the real head.
        uint256 head = pendingHead[turns][marketKind];
        uint256 tail = pendingTail[turns][marketKind];
        while (head < tail && !pendingQueue[turns][marketKind][head].exists) head++;
        if (head >= tail) {
            pendingHead[turns][marketKind] = head;
            revert NoPendingMatch();
        }

        // CEI: copy to memory and clear state before any external call.
        PendingMatch memory m = pendingQueue[turns][marketKind][head];
        delete pendingQueue[turns][marketKind][head];
        pendingHead[turns][marketKind] = head + 1;

        _startOrRefund(m.playerA, m.playerB, m.fighterA, m.fighterB, m.turns, m.totalPot, m.marketKind);
    }

    /// @notice Withdraw a queued pair and refund both players. Either player of
    ///         that pair may call it.
    ///
    ///         Without this a pair could be stuck indefinitely: cancelQueue only
    ///         covers the un-matched slot, so once two players paired into a full
    ///         Arena their deposits had no exit at all.
    /// @param position  Queue position, as returned by getPending / pendingHead.
    function cancelPending(uint16 turns, uint8 marketKind, uint256 position) external {
        PendingMatch memory m = pendingQueue[turns][marketKind][position];
        if (!m.exists) revert NoPendingMatch();
        if (msg.sender != m.playerA && msg.sender != m.playerB) revert NotYourMatch();

        // Effects before interaction: leave a tombstone the queue walk skips.
        delete pendingQueue[turns][marketKind][position];

        uint256 eachRefund = m.totalPot / 2;
        if (!usdso.transfer(m.playerA, eachRefund)) revert TransferFailed();
        if (!usdso.transfer(m.playerB, m.totalPot - eachRefund)) revert TransferFailed();

        emit PendingCancelled(position, m.playerA, m.playerB, turns);
    }

    // ─── Cancel queue entry ───────────────────────────────────────────────────

    /// @notice Leave the queue and reclaim your deposit.
    ///         Only callable ≥ CANCEL_DELAY_BLOCKS after queueing.
    function cancelQueue(uint16 turns, uint8 marketKind) external {
        Slot storage slot = slots[turns][marketKind];
        if (slot.player != msg.sender) revert NotQueued();
        // Rate-limit cancels to prevent same-block queue-grief (M-3 fix)
        if (block.number < slot.queuedBlock + CANCEL_DELAY_BLOCKS) revert CancelTooSoon();

        uint256 refund = slot.deposit;
        delete slots[turns][marketKind]; // effect before transfer (CEI)

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

        (,,,,,,,, uint8 status,,, uint8 winnerSlot) = arena.duels(duelId);
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

        // On a draw neither player takes the other's stake: each gets half the
        // recovered pot back, less the arena fee already taken at entry. Both
        // deposited the same amount, so half the pot is each player's own money.
        //
        // Split by ROLE, not by claim order, so the odd wei is deterministic and
        // the two claims can never together exceed the pot.
        uint256 payout;
        if (winnerSlot == DRAW_SLOT) {
            uint256 half = m.totalPot / 2;
            payout = isA ? half : m.totalPot - half;
        } else {
            bool callerWon = (winnerSlot == 0 && isA) || (winnerSlot == 1 && isB);
            payout = callerWon ? m.totalPot : 0;
        }

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
        (,,,,,,,, uint8 status,,,) = arena.duels(duelId);
        require(status == STATUS_RESOLVED, "not resolved");

        m.recovered = true;
        m.totalPot  = 0;
        emit EmergencyRecoverySet(duelId, 0);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice USDso amount each player must approve before calling queue().
    function halfDeposit(uint16 turns, uint8 marketKind) public view returns (uint256) {
        uint256 minDep = arena.minDepositForKind(turns, marketKind);
        if (minDep == 0) minDep = 2e18;
        uint256 total  = minDep + arena.platformFee(turns);
        total += (total * _bufferBpsFor(marketKind)) / 10_000;
        return (total + 1) / 2; // ceil — ensures combined >= required + buffer
    }

    /// @dev Headroom exists because `minDepositFor` reads a thin, volatile book, so
    ///      the amount required at match time can be higher than the amount quoted at
    ///      queue time. A perps entry is a fixed advertised constant computed before
    ///      any pool is touched — it cannot drift, so there is nothing to leave room
    ///      for. Charging it anyway turned an advertised 2.40 entry into 3.00 and then
    ///      refunded the difference: two extra transfers, a larger approval for the
    ///      player to grant, and a lobby price that did not match what was taken.
    function _bufferBpsFor(uint8 marketKind) internal pure returns (uint256) {
        return marketKind == KIND_PERPS ? 0 : DEPOSIT_BUFFER_BPS;
    }

    function getSlot(uint16 turns, uint8 marketKind)
        external view
        returns (address player, uint8 fighter, uint256 deposit, uint64 queuedBlock)
    {
        Slot storage s = slots[turns][marketKind];
        return (s.player, s.fighter, s.deposit, s.queuedBlock);
    }

    function arenaFree() external view returns (bool) { return _arenaFree(); }

    /// @notice How many pairs are waiting in a tier's queue (tombstones excluded).
    function pendingCount(uint16 turns, uint8 marketKind) public view returns (uint256 n) {
        uint256 tail = pendingTail[turns][marketKind];
        for (uint256 i = pendingHead[turns][marketKind]; i < tail; i++) {
            if (pendingQueue[turns][marketKind][i].exists) n++;
        }
    }

    /// @notice The queue positions still waiting in a tier, in start order.
    ///         Use these as the `position` argument to cancelPending.
    function getPendingPositions(uint16 turns, uint8 marketKind)
        external view returns (uint256[] memory positions)
    {
        uint256 head = pendingHead[turns][marketKind];
        uint256 tail = pendingTail[turns][marketKind];
        uint256 n = pendingCount(turns, marketKind);
        positions = new uint256[](n);
        uint256 k = 0;
        for (uint256 i = head; i < tail; i++) {
            if (pendingQueue[turns][marketKind][i].exists) positions[k++] = i;
        }
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev "Free" now means "has a free slot", not "is idle" — Arena runs several
    ///      duels at once, so this is a capacity question rather than a busy flag.
    function _arenaFree() internal view returns (bool) {
        return arena.hasCapacity();
    }

    /// @dev Attempt to start a match. If the required deposit has drifted above
    ///      the combined deposits collected, refund both players instead of
    ///      leaving funds stranded (H-3 fix).
    function _startOrRefund(
        address pA, address pB,
        uint8 fA, uint8 fB,
        uint16 turns, uint256 total, uint8 marketKind
    ) internal {
        // Re-query required amount at match time (market prices may have moved)
        uint256 minDep = arena.minDepositForKind(turns, marketKind);
        if (minDep == 0) minDep = 2e18;
        uint256 required = minDep + arena.platformFee(turns);

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

        // GUARDED, for the same reason the drift branch above exists: a revert here
        // reverts the whole queue transaction, and that transaction belongs to the
        // SECOND player. They would lose their gas, the first player would stay
        // queued, and the site would show a failed queue with nothing explaining it.
        // Perps adds several ways for this to fail that no other market has — too few
        // markets qualifying for the tier at that moment, a registry float too small
        // to fund a fighter, a full arena — and none of them is the player's fault.
        uint256 duelId;
        try arena.startDuelOn(fA, fB, turns, marketKind) returns (uint256 id) {
            duelId = id;
        } catch {
            // Same shape as the drift refund: drop the approval, return every wei
            // collected, and say so. Odd-wei dust to pB.
            usdso.approve(address(arena), 0);
            uint256 each = total / 2;
            if (!usdso.transfer(pA, each)) revert TransferFailed();
            if (!usdso.transfer(pB, total - each)) revert TransferFailed();
            emit MatchRefunded(pA, pB, turns, each, "duel start rejected");
            return;
        }

        // H-4 fix: reset approval to zero after startDuel consumed it
        usdso.approve(address(arena), 0);

        // Refund the deposit buffer surplus (total - required) so it never strands
        // in the Matchmaker. Split evenly; odd-wei dust goes to pB.
        uint256 surplus = total - required;
        if (surplus > 0) {
            uint256 backA = surplus / 2;
            if (backA > 0 && !usdso.transfer(pA, backA)) revert TransferFailed();
            uint256 backB = surplus - backA;
            if (backB > 0 && !usdso.transfer(pB, backB)) revert TransferFailed();
        }

        matches[duelId] = Match({
            playerA:   pA,
            playerB:   pB,
            totalPot:  required,   // amount actually deposited into the duel (buffer refunded)
            recovered: false,
            settledA:  false,
            settledB:  false
        });

        emit MatchStarted(duelId, pA, pB, fA, fB, turns);
    }
}
