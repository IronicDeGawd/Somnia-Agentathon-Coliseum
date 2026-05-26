// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IArena.sol";
import "./interfaces/IBookmaker.sol";
import "./interfaces/IERC20Minimal.sol";
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
    address public owner;

    uint16 public constant BPS_TOTAL = 10000;
    uint16 public constant RAKE_BPS = 500;           // 5%
    uint16 public constant PAYOUT_FACTOR_BPS = 9500; // 95%

    mapping(uint256 => Bet[]) public bets;                // duelId => bets
    mapping(uint256 => uint16[2]) public currentOdds;     // duelId => [oddsA, oddsB] bps, sum = 10000
    mapping(uint256 => bool) public duelSettled;          // duelId => bool
    mapping(uint256 => uint256) public rakeAccrued;       // duelId => rake amount USDso

    event SubscriptionSkipped(string reason);
    event OddsInitialized(uint256 indexed duelId, uint16 oddsA, uint16 oddsB);
    event BetPlaced(uint256 indexed duelId, uint8 indexed fighterId, address indexed bettor, uint256 stake, uint16 oddsAtPlacementBps, uint256 betIndex);
    event OddsUpdated(uint256 indexed duelId, uint16 oddsA, uint16 oddsB);
    event BetsSettled(uint256 indexed duelId, uint8 indexed winnerId, uint256 totalPayout, uint256 rake);
    event RakeWithdrawn(uint256 indexed duelId, address indexed to, uint256 amount);
    event Resubscribed(uint256 indexed newSubscriptionId);
    event NativeWithdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _arena, address _usdso, uint256 _turnIntervalBlocks) payable {
        if (msg.value < REACTIVITY_FUND_MIN) revert ReactivityUnderfunded();
        arena = IArena(_arena);
        usdso = IERC20Minimal(_usdso);
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;
        owner = msg.sender;

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

    function _onBlockTick(uint64 /*blockNumber*/) internal {
        // v1.1: LLM-driven odds update scheduled for next phase
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
        // Odds uninitialized means duel is not active for betting
        if (lockedOdds == 0) revert DuelInactive();

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

    function settleBets(uint256 duelId, uint8 winnerId) external {
        if (winnerId > 1) revert InvalidWinner();
        if (duelSettled[duelId]) revert DuelAlreadySettled();

        // Only settle once the duel is resolved on-chain (status == 4)
        (, , , , , uint8 status, , ) = arena.duels(duelId);
        if (status != 4) revert DuelInactive();

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
