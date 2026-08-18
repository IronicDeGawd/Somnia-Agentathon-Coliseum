// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IArena.sol";
import "./interfaces/IBookmaker.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/IFighterRegistry.sol";
import "./interfaces/IMatchmaker.sol";
import "./interfaces/ISomniaAgents.sol";
import "./interfaces/ISomniaReactivityPrecompile.sol";

contract Bookmaker is IBookmaker {
    error NotOwner();
    error NotArena();
    error InvalidFighter();
    error DuelInactive();
    error DuelAlreadySettled();
    error InvalidOdds();
    error ZeroStake();
    error TransferFailed();
    error InvalidWinner();
    error InsufficientBookmakerBalance(uint256 required, uint256 actual);
    error NothingToWithdraw();
    error ReactivityUnderfunded();
    error OnlyPlatform();
    error PendingRequest();
    error InsufficientStt();
    error DuelistCannotBet();
    error BadMatchmaker();

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant REACTIVITY_FUND_MIN = 33 ether;
    uint256 public subscriptionId;
    uint256 public TURN_INTERVAL_BLOCKS;

    /// @notice Whether re-pricing is driven by Reactivity. Explicit rather than
    ///         inferred from subscriptionId, because a one-shot subscription is
    ///         absent most of the time and "absent" must not read as "switched off".
    bool public reactivityOn;

    /// @notice The block named in the live subscription's topic; zero if nothing is
    ///         armed. Compared before re-arming, so an already-correct subscription
    ///         is not paid for twice.
    uint64 public armedForBlock;

    // fighterId in bets is a relative index: 0 = fighterA, 1 = fighterB (NOT the global fighter id)
    struct Bet {
        address bettor;
        uint8   fighterId;
        uint256 stake;
        uint16  oddsAtPlacementBps;  // locked at time of bet, 0..10000
        bool    settled;
    }

    IArena public immutable arena;
    IERC20Minimal public immutable usdso;
    IFighterRegistry public immutable registry;
    IMatchmaker public immutable matchmaker;
    address public immutable PLATFORM_ADDR;
    address public owner;

    // Somnia Agents constants — same agent ID Arena uses for fighters.
    uint256 public constant LLM_AGENT_ID = 12847293847561029384;
    // per-agent budget × 3 validators; mirrors Arena.FIGHTER_DEPOSIT_TOPUP
    uint256 public constant ODDS_DEPOSIT_TOPUP = 0.07 ether;
    // Floor odds the LLM can produce — never let either side hit 0% (infinite payout)
    // or 100% (no payout). 500 bps = 5%, 9500 bps = 95%.
    uint16 public constant MIN_ODDS_BPS = 500;
    uint16 public constant MAX_ODDS_BPS = 9500;

    uint16 public constant BPS_TOTAL = 10000;
    uint16 public constant RAKE_BPS = 500;           // 5%
    uint16 public constant PAYOUT_FACTOR_BPS = 9500; // 95%

    /// @dev Mirror of ArenaTypes.DuelStatus. Hardcoded because we read the Arena
    ///      tuple via the IArena interface (no enum import). The enum is
    ///      { None=0, Active=1, Finalizing=2, Resolved=3 } — if ArenaTypes ever
    ///      reorders, update both constants.
    uint8 public constant ARENA_STATUS_ACTIVE   = 1;
    uint8 public constant ARENA_STATUS_RESOLVED = 3;
    /// @dev Mirrors ArenaTypes.DRAW_SLOT = 2 — neither fighter won.
    uint8 public constant ARENA_DRAW_SLOT = 2;

    mapping(uint256 => Bet[]) public bets;                // duelId => bets
    mapping(uint256 => uint16[2]) public currentOdds;     // duelId => [oddsA, oddsB] bps, sum = 10000
    mapping(uint256 => bool) public duelSettled;          // duelId => bool
    mapping(uint256 => uint256) public rakeAccrued;       // duelId => rake amount USDso

    // ─── LLM odds updater state ──────────────────────────────────────────────
    // One pending request at a time per duel. Cleared when the callback lands
    // (or after a long enough block-delta if the callback never arrives — see
    // the cooldown check in _onBlockTick).
    mapping(uint256 => bool)    public pendingOddsRequest;       // duelId => in-flight?
    mapping(uint256 => uint256) public lastOddsUpdateBlock;      // duelId => block of last update/request
    mapping(uint256 => uint256) public oddsRequestToDuel;        // requestId => duelId (callback lookup)

    event SubscriptionSkipped(string reason);
    event OddsInitialized(uint256 indexed duelId, uint16 oddsA, uint16 oddsB);
    event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex);
    event OddsUpdated(uint256 indexed duelId, uint16 oddsA, uint16 oddsB);
    event BetsSettled(uint256 indexed duelId, uint8 indexed winnerId, uint256 totalPayout, uint256 rake);
    event RakeWithdrawn(uint256 indexed duelId, address indexed to, uint256 amount);
    event Resubscribed(uint256 indexed newSubscriptionId);
    event NativeWithdrawn(address indexed to, uint256 amount);
    event OddsRequestSent(uint256 indexed duelId, uint256 indexed requestId, uint256 blockNumber);
    event OddsRequestFailed(uint256 indexed duelId, string reason);

    /// @notice A one-shot tick was booked for `targetBlock`. A zero subscriptionId is
    ///         the only visible sign that the chain of ticks has stopped.
    event TickArmed(uint64 targetBlock, uint256 subscriptionId);
    event TickCancelled(uint256 subscriptionId);
    event ReactivityDisabled();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _arena,
        address _usdso,
        address _registry,
        address _matchmaker,
        address _platform,
        uint256 _turnIntervalBlocks
    ) payable {
        // Reactivity is OPT-IN: call resubscribe() to switch it on, disableReactivity()
        // to switch it off. Nothing here subscribes, because a deploy should not start
        // spending before a line is open. Each firing is now booked for one named
        // block and cancelled when the bets settle, so an idle book pays nothing —
        // measured 0.0045 STT per firing against ~31 STT/hour for the every-block
        // subscription this replaced. See Arena's constructor.
        // Must be a contract — an EOA/typo would silently disable the duelist guard.
        if (_matchmaker.code.length == 0) revert BadMatchmaker();
        arena         = IArena(_arena);
        usdso         = IERC20Minimal(_usdso);
        registry      = IFighterRegistry(_registry);
        matchmaker    = IMatchmaker(_matchmaker);
        PLATFORM_ADDR = _platform;
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;
        owner         = msg.sender;
    }

    receive() external payable {}

    // ─── Reactivity: one subscription, aimed at the next re-price ────────────
    //
    // A zero in eventTopics[1] means EVERY block — ~10.5 firings a second, ~31
    // STT/hour, burning identically whether a line was open or the book was shut.
    // A block NUMBER there fires once, at that block, for 0.0045 STT including
    // booking the next one. See ArenaStorage for the measurements.
    //
    // What it buys in exchange is fragility: each firing books the next, so one
    // firing that never lands stops the re-pricing silently. Odds going stale is
    // survivable — bets lock the odds at placement — but the keeper watches anyway.

    /// @notice The block at which the open line is next due a re-price, or zero if
    ///         no line is open. A due block already in the past becomes one interval
    ///         from now, since a block in the past can never fire.
    function _nextRepriceBlock() internal view returns (uint64) {
        uint256 duelId = arena.activeDuelId();
        if (duelId == 0) return 0;
        if (duelSettled[duelId]) return 0;
        // Line not opened yet: nothing to re-price.
        if (uint256(currentOdds[duelId][0]) + uint256(currentOdds[duelId][1]) != BPS_TOTAL) return 0;
        uint256 last = lastOddsUpdateBlock[duelId];
        uint256 due  = (last == 0 ? block.number : last) + TURN_INTERVAL_BLOCKS;
        // One full interval, not the next block. Several paths through _onBlockTick
        // return without writing lastOddsUpdateBlock — a request already in flight,
        // too little STT, the arena no longer Active. Arming for the next block in
        // those cases would quietly restore per-block firing, which is the whole
        // cost this change exists to remove.
        if (due <= block.number) due = block.number + TURN_INTERVAL_BLOCKS;
        return uint64(due);
    }

    function _scheduleNextTick() internal {
        if (!reactivityOn) return;
        uint64 target = _nextRepriceBlock();
        if (target == 0) {
            _cancelTick();
            return;
        }
        if (target == armedForBlock && subscriptionId != 0) return;
        if (subscriptionId != 0) _unsubscribeReactivity(subscriptionId);
        uint256 newId = _subscribeReactivity(target);
        subscriptionId = newId;
        // A failed subscribe must leave nothing armed, so the next caller retries
        // rather than trusting a tick that was never booked.
        armedForBlock  = newId == 0 ? 0 : target;
        emit TickArmed(target, newId);
    }

    function _cancelTick() internal {
        uint256 id = subscriptionId;
        if (id != 0) _unsubscribeReactivity(id);
        subscriptionId = 0;
        armedForBlock  = 0;
        if (id != 0) emit TickCancelled(id);
    }

    /// @dev Best-effort. A failed cancel must never revert the settlement that
    ///      triggered it — the cost of that is one stray firing, not stuck money.
    function _unsubscribeReactivity(uint256 id) internal {
        (bool ok, ) = SOMNIA_REACTIVITY_PRECOMPILE.call(
            abi.encodeWithSelector(ISomniaReactivityPrecompile.unsubscribe.selector, id)
        );
        if (!ok) emit SubscriptionSkipped("unsubscribe failed");
    }

    function _subscribeReactivity(uint64 targetBlock) internal returns (uint256 newId) {
        ISomniaReactivityPrecompile.SubscriptionData memory data = ISomniaReactivityPrecompile.SubscriptionData({
            eventTopics: [
                keccak256("BlockTick(uint64)"),
                // The whole point of the change. A zero here means every block.
                bytes32(uint256(targetBlock)),
                bytes32(0),
                bytes32(0)
            ],
            origin: address(0),
            caller: address(0),
            emitter: SOMNIA_REACTIVITY_PRECOMPILE,
            handlerContractAddress: address(this),
            handlerFunctionSelector: this.onEvent.selector,
            // Priority fee must beat testnet baseFee (~6 gwei) AND ambient
            // background subscription traffic, or our handler is indefinitely
            // deferred in the per-block reactivity queue.
            priorityFeePerGas: 10_000_000_000,
            maxFeePerGas:      50_000_000_000,
            // Bookmaker _onBlockTick builds the LLM prompt by reading both fighters'
            // system prompts from the registry + balances from Arena. 3M was likely
            // tight on the LLM-request path. Bumped to 10M.
            gasLimit:          10_000_000,
            isGuaranteed: false,
            isCoalesced: false
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
            emit SubscriptionSkipped("precompile unavailable");
        }
    }

    /// @notice Switch re-pricing over to Reactivity, arming now if a line is open.
    ///         The signature is unchanged on purpose: a changed signature leaves the
    ///         old selector pointing at retired behaviour, so an existing entry point
    ///         is reused wherever the body can carry the change.
    function resubscribe() external returns (uint256 newId) {
        if (msg.sender != owner) revert NotOwner();
        if (address(this).balance < REACTIVITY_FUND_MIN) revert ReactivityUnderfunded();
        reactivityOn = true;
        _scheduleNextTick();
        newId = subscriptionId;
        emit Resubscribed(newId);
    }

    /// @notice Switch it off and cancel anything armed. One call, no redeploy.
    function disableReactivity() external {
        if (msg.sender != owner) revert NotOwner();
        reactivityOn = false;
        _cancelTick();
        emit ReactivityDisabled();
    }

    function withdrawNative(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (amount == 0) revert ZeroStake();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit NativeWithdrawn(to, amount);
    }

    function onEvent(address /*emitter*/, bytes32[] calldata eventTopics, bytes calldata /*data*/) external {
        if (msg.sender != SOMNIA_REACTIVITY_PRECOMPILE) return;
        if (eventTopics.length < 2) return;
        uint64 blockNumber = uint64(uint256(eventTopics[1]));
        // No multiple-of-interval check. That existed only because the subscription
        // fired on every block and nearly every firing had to be discarded; against
        // a subscription aimed at one named block it would discard the firing we paid
        // for. _onBlockTick's own cooldown is the real guard.
        _onBlockTick(blockNumber);
        // Re-arm here rather than at the end of _onBlockTick: that function returns
        // early on half a dozen paths, and every one of them would otherwise end the
        // chain.
        _scheduleNextTick();
    }

    function _onBlockTick(uint64 blockNumber) internal {
        // Pick up whatever duel the Arena currently considers active. If none, skip.
        uint256 duelId = arena.activeDuelId();
        if (duelId == 0) return;

        // Only re-price if the betting line has been opened (initializeOdds was called).
        uint16 oA = currentOdds[duelId][0];
        uint16 oB = currentOdds[duelId][1];
        if (uint256(oA) + uint256(oB) != BPS_TOTAL) return;

        // Don't update odds for a settled duel.
        if (duelSettled[duelId]) return;

        // One LLM request in flight at a time. If a callback never landed, the
        // cooldown below acts as an escape hatch.
        if (pendingOddsRequest[duelId]) {
            // Escape hatch: if a request has been pending for more than 4 turn
            // intervals, assume it's lost and clear the flag so we can try again.
            if (blockNumber > lastOddsUpdateBlock[duelId] + TURN_INTERVAL_BLOCKS * 4) {
                pendingOddsRequest[duelId] = false;
            } else {
                return;
            }
        }

        // Make sure we have enough STT for both the LLM request AND a Reactivity
        // floor. If draining a request would put us below 32 STT we skip — the
        // sub itself is more important than this one odds update.
        IAgentRequester platform = IAgentRequester(PLATFORM_ADDR);
        uint256 deposit = platform.getRequestDeposit() + ODDS_DEPOSIT_TOPUP * 3;
        if (address(this).balance < REACTIVITY_FUND_MIN + deposit) {
            emit OddsRequestFailed(duelId, "insufficient STT");
            return;
        }

        // Arena must still be Active. Tuple positions:
        //   0 fA, 1 fB, 2 creator, 3 startBlock, 4 lastTurnBlock, 5 completedCallbacks,
        //   6 turns, 7 poolMask, 8 status, 9 initialUsdsoPerFighter,
        //   10 fundsRecovered, 11 winnerSlot
        (uint8 fighterA, uint8 fighterB, , , , , , , uint8 arenaStatus, , , ) = arena.duels(duelId);
        if (arenaStatus != ARENA_STATUS_ACTIVE) return;

        // Build the prompt and fire the LLM request. inferNumber(0, 100) returns
        // an estimated win-probability % for fighterA.
        string memory prompt = _buildOddsPrompt(duelId, fighterA, fighterB);
        string memory system = "You are a sports bookmaker. Given two AI trader personalities and their current portfolio values, output a single integer 0..100 = probability that Fighter A wins.";

        bytes memory payload = abi.encodeWithSelector(
            ILLMInferenceAgent.inferNumber.selector,
            prompt,
            system,
            int256(0), int256(100),
            false
        );

        try platform.createRequest{value: deposit}(
            LLM_AGENT_ID,
            address(this),
            this.handleBookmakerResponse.selector,
            payload
        ) returns (uint256 requestId) {
            pendingOddsRequest[duelId]      = true;
            lastOddsUpdateBlock[duelId]     = blockNumber;
            oddsRequestToDuel[requestId]    = duelId;
            emit OddsRequestSent(duelId, requestId, blockNumber);
        } catch {
            emit OddsRequestFailed(duelId, "createRequest reverted");
        }
    }

    /// @dev Build a short market-context prompt for the bookmaker LLM.
    ///      Includes both fighter system prompts (their personalities) and
    ///      current portfolio values across active pools. Cheap enough for
    ///      every-turn LLM context.
    function _buildOddsPrompt(uint256 duelId, uint8 fighterA, uint8 fighterB)
        internal
        view
        returns (string memory)
    {
        IFighterRegistry.Fighter memory fA = registry.getFighter(fighterA);
        IFighterRegistry.Fighter memory fB = registry.getFighter(fighterB);

        return string.concat(
            "Duel #", _toString(duelId), ". ",
            "Fighter A (", fA.name, "): ", fA.systemPrompt, " ",
            "Fighter B (", fB.name, "): ", fB.systemPrompt, " ",
            "Output integer 0..100 = probability A wins."
        );
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory buf = new bytes(78);
        uint256 len = 0;
        uint256 tmp = v;
        while (tmp > 0) { buf[len++] = bytes1(uint8(48 + (tmp % 10))); tmp /= 10; }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = buf[len - 1 - i];
        return string(out);
    }

    /// @notice Somnia Agents callback. Decodes the inferNumber result, clamps it
    ///         to [MIN_ODDS_BPS, MAX_ODDS_BPS], and writes the new odds line.
    ///         No-ops if the duel settled, Arena is no longer Active, or the
    ///         response is malformed/failed — odds simply don't move that turn.
    function handleBookmakerResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory /* details */
    ) external {
        if (msg.sender != PLATFORM_ADDR) revert OnlyPlatform();

        uint256 duelId = oddsRequestToDuel[requestId];
        // Unknown requestId — ignore silently to keep the platform happy.
        if (duelId == 0) return;
        delete oddsRequestToDuel[requestId];

        // Always clear the pending flag, regardless of outcome.
        pendingOddsRequest[duelId] = false;

        if (duelSettled[duelId]) return;
        // Re-check Arena status — Arena may have finalized while the LLM was thinking.
        (, , , , , , , , uint8 arenaStatus, , , ) = arena.duels(duelId);
        if (arenaStatus != ARENA_STATUS_ACTIVE) return;

        if (status != ResponseStatus.Success || responses.length == 0) {
            emit OddsRequestFailed(duelId, "no consensus");
            return;
        }
        if (responses[0].result.length != 32) {
            emit OddsRequestFailed(duelId, "bad encoding");
            return;
        }
        int256 raw = abi.decode(responses[0].result, (int256));
        if (raw < 0 || raw > 100) {
            emit OddsRequestFailed(duelId, "out of range");
            return;
        }

        // Convert % to BPS, then clamp to [MIN, MAX] so we never produce 0 or 10000.
        uint16 bpsA = uint16(uint256(raw) * 100);
        if (bpsA < MIN_ODDS_BPS) bpsA = MIN_ODDS_BPS;
        if (bpsA > MAX_ODDS_BPS) bpsA = MAX_ODDS_BPS;
        uint16 bpsB = BPS_TOTAL - bpsA;

        currentOdds[duelId][0] = bpsA;
        currentOdds[duelId][1] = bpsB;
        emit OddsUpdated(duelId, bpsA, bpsB);
    }

    function initializeOdds(uint256 duelId, uint16 oddsA, uint16 oddsB) external onlyOwner {
        if (uint256(oddsA) + uint256(oddsB) != BPS_TOTAL) revert InvalidOdds();
        // Already initialized if either slot is non-zero
        if (currentOdds[duelId][0] != 0 || currentOdds[duelId][1] != 0) revert InvalidOdds();
        currentOdds[duelId][0] = oddsA;
        currentOdds[duelId][1] = oddsB;
        emit OddsInitialized(duelId, oddsA, oddsB);
        // Opening the line is what starts the chain — nothing is armed before it.
        _scheduleNextTick();
    }

    function updateOdds(uint256 duelId, uint16 oddsA, uint16 oddsB) external onlyOwner {
        if (uint256(oddsA) + uint256(oddsB) != BPS_TOTAL) revert InvalidOdds();
        currentOdds[duelId][0] = oddsA;
        currentOdds[duelId][1] = oddsB;
        emit OddsUpdated(duelId, oddsA, oddsB);
    }

    function placeBet(uint256 duelId, uint8 fighterId, uint256 stake) external {
        if (stake == 0) revert ZeroStake();
        // fighterId is relative: 0 = fighterA, 1 = fighterB
        if (fighterId > 1) revert InvalidFighter();
        if (duelSettled[duelId]) revert DuelAlreadySettled();

        uint16 lockedOdds = currentOdds[duelId][fighterId];
        // Odds uninitialized means the bookmaker hasn't opened the line yet.
        if (lockedOdds == 0) revert DuelInactive();

        // Reject bets after the Arena has moved past Active (Finalizing or Resolved).
        // Stops the awkward window between finalizeDuel and settleBets where odds
        // are stale but bets would still be accepted. Reads one slot from Arena.
        (, , , , , , , , uint8 arenaStatus, , , ) = arena.duels(duelId);
        if (arenaStatus != ARENA_STATUS_ACTIVE) revert DuelInactive();

        // A duel's two players cannot bet on their own fight. For non-matchmaker
        // duels (no human players) matches() returns zero addresses, so this never
        // blocks a legitimate spectator. Wrapped in try/catch so a future Matchmaker
        // that is replaced/bricked degrades to "guard skipped" (the UI also blocks
        // duelists) rather than freezing all betting.
        try matchmaker.matches(duelId) returns (
            address pA, address pB, uint256, bool, bool, bool
        ) {
            if (msg.sender == pA || msg.sender == pB) revert DuelistCannotBet();
        } catch {}

        // CEI: state update before external call
        uint256 betIndex = bets[duelId].length;
        bets[duelId].push(Bet({
            bettor: msg.sender,
            fighterId: fighterId,
            stake: stake,
            oddsAtPlacementBps: lockedOdds,
            settled: false
        }));

        bool ok = usdso.transferFrom(msg.sender, address(this), stake);
        if (!ok) revert TransferFailed();

        emit BetPlaced(duelId, fighterId, msg.sender, stake, lockedOdds, betIndex);
    }

    /// @notice Settle bets for a resolved duel. The winner is read from Arena's Duel.winnerSlot
    ///         (set authoritatively in _resolveDuel) — not from the caller — so settlement
    ///         outcome cannot be manipulated by passing a wrong winnerId.
    function settleBets(uint256 duelId) external {
        if (duelSettled[duelId]) revert DuelAlreadySettled();

        // Read status + winnerSlot from Arena. Tuple layout (12 fields):
        //   fighterA, fighterB, creator, startBlock, lastTurnBlock, completedCallbacks,
        //   turns, poolMask, status, initialUsdsoPerFighter, fundsRecovered, winnerSlot
        (, , , , , , , , uint8 status, , , uint8 winnerSlot) = arena.duels(duelId);
        if (status != ARENA_STATUS_RESOLVED) revert DuelInactive();
        bool isDraw = winnerSlot == ARENA_DRAW_SLOT;
        if (winnerSlot > 1 && !isDraw) revert InvalidWinner();
        uint8 winnerId = winnerSlot;

        uint256 totalLosingStake = 0;
        uint256 totalWinningStake = 0;

        Bet[] storage duelBets = bets[duelId];
        uint256 len = duelBets.length;

        // A draw has no losing side to pay winners from, so nobody's bet is settled
        // against anybody: every stake goes back whole. Raking a draw would charge
        // bettors a fee for an outcome the book never resolved.
        for (uint256 i = 0; i < len; i++) {
            if (isDraw || duelBets[i].fighterId == winnerId) {
                totalWinningStake += duelBets[i].stake;
            } else {
                totalLosingStake += duelBets[i].stake;
            }
        }

        // rake = 5% of losing pool; remainder funds winner winnings
        // Integer division: rounding down leaves dust in contract
        uint256 rake = totalLosingStake * RAKE_BPS / BPS_TOTAL;
        uint256 losingPoolAfterRake = totalLosingStake - rake;

        uint256 contractBalance = usdso.balanceOf(address(this));
        uint256 requiredFunds = totalWinningStake + losingPoolAfterRake;
        if (contractBalance < requiredFunds) revert InsufficientBookmakerBalance(requiredFunds, contractBalance);

        // CEI: mark settled before any transfers
        duelSettled[duelId] = true;
        rakeAccrued[duelId] = rake;

        uint256 totalPayout = 0;

        for (uint256 i = 0; i < len; i++) {
            Bet storage bet = duelBets[i];
            if (!isDraw && bet.fighterId != winnerId) continue;

            // Winners receive their stake back plus a proportional share of the losing pool.
            // Winnings = losingPoolAfterRake * (bet.stake / totalWinningStake)
            // Integer division rounding down leaves dust in contract.
            uint256 winnings = totalWinningStake > 0
                ? losingPoolAfterRake * bet.stake / totalWinningStake
                : 0;
            uint256 payout = bet.stake + winnings;

            bet.settled = true;
            totalPayout += payout;

            bool ok = usdso.transfer(bet.bettor, payout);
            if (!ok) revert TransferFailed();
        }

        emit BetsSettled(duelId, winnerId, totalPayout, rake);

        // The line is closed, so stop paying for ticks. Last thing in the function on
        // purpose: settlement can still revert above this point, and a cancel that is
        // rolled back with it is a cancel that never happened.
        _cancelTick();
    }

    function withdrawRake(uint256 duelId, address to) external onlyOwner {
        if (!duelSettled[duelId]) revert DuelInactive();
        uint256 amount = rakeAccrued[duelId];
        if (amount == 0) revert NothingToWithdraw();
        rakeAccrued[duelId] = 0;
        emit RakeWithdrawn(duelId, to, amount);
        bool ok = usdso.transfer(to, amount);
        if (!ok) revert TransferFailed();
    }

    function notifyDuelResolved(uint256, uint8) external pure {}
}
