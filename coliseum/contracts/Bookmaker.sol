// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IArena.sol";
import "./interfaces/IBookmaker.sol";
import "./interfaces/IERC20Minimal.sol";
import "./interfaces/IFighterRegistry.sol";
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

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant REACTIVITY_FUND_MIN = 33 ether;
    uint256 public subscriptionId;
    uint256 public TURN_INTERVAL_BLOCKS;

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

    /// @dev Mirror of ArenaTypes.DuelStatus.Active. Hardcoded because we read the
    ///      Arena tuple via the IArena interface (no enum import). If ArenaTypes
    ///      ever changes the Active position, update this constant.
    uint8 public constant ARENA_STATUS_ACTIVE = 1;

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

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _arena,
        address _usdso,
        address _registry,
        address _platform,
        uint256 _turnIntervalBlocks
    ) payable {
        if (msg.value < REACTIVITY_FUND_MIN) revert ReactivityUnderfunded();
        arena         = IArena(_arena);
        usdso         = IERC20Minimal(_usdso);
        registry      = IFighterRegistry(_registry);
        PLATFORM_ADDR = _platform;
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;
        owner         = msg.sender;

        subscriptionId = _subscribeReactivity();
    }

    receive() external payable {}

    function _subscribeReactivity() internal returns (uint256 newId) {
        ISomniaReactivityPrecompile.SubscriptionData memory data = ISomniaReactivityPrecompile.SubscriptionData({
            eventTopics: [
                keccak256("BlockTick(uint64)"),
                bytes32(0),
                bytes32(0),
                bytes32(0)
            ],
            origin: address(0),
            caller: address(0),
            emitter: SOMNIA_REACTIVITY_PRECOMPILE,
            handlerContractAddress: address(this),
            handlerFunctionSelector: this.onEvent.selector,
            priorityFeePerGas: 2_000_000_000,
            maxFeePerGas: 20_000_000_000,
            gasLimit: 3_000_000,
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

    function resubscribe() external returns (uint256 newId) {
        if (msg.sender != owner) revert NotOwner();
        if (address(this).balance < REACTIVITY_FUND_MIN) revert ReactivityUnderfunded();
        newId = _subscribeReactivity();
        subscriptionId = newId;
        emit Resubscribed(newId);
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
        if (blockNumber % TURN_INTERVAL_BLOCKS != 0) return;
        _onBlockTick(blockNumber);
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
        if (status != 2) revert DuelInactive();
        if (winnerSlot > 1) revert InvalidWinner();
        uint8 winnerId = winnerSlot;

        uint256 totalLosingStake = 0;
        uint256 totalWinningStake = 0;

        Bet[] storage duelBets = bets[duelId];
        uint256 len = duelBets.length;

        for (uint256 i = 0; i < len; i++) {
            if (duelBets[i].fighterId == winnerId) {
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
            if (bet.fighterId != winnerId) continue;

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
