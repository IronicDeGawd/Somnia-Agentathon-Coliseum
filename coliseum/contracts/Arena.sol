// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ArenaStorage.sol";
import "./lib/ArenaTypes.sol";
import "./interfaces/IFighterRegistry.sol";

/// @title Arena
/// @notice 1v1 AI-agent trading duel orchestrator on Somnia — the front door.
///
///  Arena is one address made of several contracts. This one holds the storage
///  and the funds and owns the address everything else points at; the behaviour
///  lives in parts, each deployed separately and reached by delegatecall so it
///  runs against this contract's storage and balance:
///
///    ArenaVaultPart  seeding vaults, registering market sets, sweeps, fees
///    ArenaDuelPart   startDuel, startEventDuel, finalize, recoverFunds
///    ArenaTurnPart   turn advance, fighter prompts, order execution
///    ArenaViewPart   capacity, deposit quotes, prompt preview
///
///  It is split because one contract no longer fits under the 24576-byte deploy
///  limit. From outside there is still a single Arena: the same address, the same
///  function signatures, and every event still emitted from here — so the
///  frontend, Matchmaker and Bookmaker never learn that any of this happened.
///
///  Flow:
///    1. Owner deploys + calls fundPools() to seed the dreamDEX vaults.
///    2. Any user approves USDso and calls startDuel(fighterA, fighterB, turns).
///       - turns ∈ {3, 6, 9, 15}.  Tier determines which pools are active.
///       - Deposit = minDeposit(turns) + PLATFORM_FEE, pulled from msg.sender.
///       Event duels start via startEventDuel, owner-only.
///    3. Each BlockTick fires onEvent → _runTurn → two LLM inferNumber calls.
///    4. handleFighterResponse executes the chosen action on dreamDEX (FOK order).
///    5. After all turns, anyone calls finalizeDuel → DuelResolved emitted.
///    6. Duel creator calls recoverFunds(duelId) to withdraw their USDso back.
///
///  Safety:
///    - expireTurn(): owner can unblock a stuck pending LLM request after deadline.
///    - emergencyFinalize(): owner can force-resolve a duel stuck in Active state
///      after EMERGENCY_FINALIZE_BLOCKS blocks have passed since the last turn,
///      without waiting for remaining callbacks. Funds remain recoverable.
///    - recoverFunds(): duel creator can always pull their USDso back after resolution.
///    - setPart(): parts may only be rewired while no duel is running and nothing
///      is escrowed, so a fight in progress cannot have its rules changed and
///      money in flight cannot be reached by new code.
contract Arena is ArenaStorage {

    // Constants and state both live in ArenaStorage.
    // Nothing in this file may declare storage — see the note in ArenaStorage.sol.

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _registry,
        address _usdso,
        address _poolWeth,
        address _poolWbtc,
        address _poolSomi,
        address _platform,
        uint256 _turnIntervalBlocks,
        uint8[3] memory _baseDecimals   // [WETH, WBTC, SOMI]
    ) payable {
        // Reactivity is OPT-IN: call resubscribe() to switch it on.
        //
        // This used to demand 33 STT up front and subscribe in the constructor.
        // A BlockTick subscription bills every block whether or not a duel is
        // running — ~25.8 STT/hour, about 1,240 STT/day once Bookmaker is counted
        // too — so a fresh deploy started burning immediately and silently.
        //
        // It CAN be stopped: SomniaExtensions.unsubscribe(subscriptionId) exists,
        // and a subscription is also dropped once the balance can no longer cover
        // the gas limit at firing time. (An earlier version of this comment said
        // there was no unsubscribe. That was wrong; the cost is the reason.)
        // Turns are keeper-driven now, so nothing here needs the subscription.
        USDSO     = _usdso;
        POOL_WETH = _poolWeth;
        POOL_WBTC = _poolWbtc;
        POOL_SOMI = _poolSomi;
        owner     = msg.sender;

        registry            = IFighterRegistry(_registry);
        PLATFORM_ADDR       = _platform;
        TURN_INTERVAL_BLOCKS = _turnIntervalBlocks;

        _cachePoolMeta(_poolWeth, _baseDecimals[0]);
        _cachePoolMeta(_poolWbtc, _baseDecimals[1]);
        _cachePoolMeta(_poolSomi, _baseDecimals[2]);
    }

    /// @notice Native STT, used to pay for fighter inference.
    receive() external payable {}

    // ─── Routing ──────────────────────────────────────────────────────────────

    /// @notice Point a set of functions at a part. Rewiring is only allowed while
    ///         nothing is at stake, so the rules of a duel already underway cannot
    ///         change and escrowed deposits cannot be reached by new code.
    /// @param  part address(0) unroutes the selectors, which then revert.
    function setPart(bytes4[] calldata selectors, address part) external onlyOwner {
        if (activeDuelIds.length != 0 || escrowedPot != 0) revert ArenaTypes.ArenaNotEmpty();
        // A delegatecall to an address holding no code succeeds and returns
        // nothing, so an unchecked typo here would answer every routed call with
        // empty data instead of failing loudly.
        if (part != address(0) && part.code.length == 0) revert ArenaTypes.PartHasNoCode(part);
        for (uint256 i = 0; i < selectors.length; i++) {
            partOf[selectors[i]] = part;
            emit ArenaTypes.PartSet(selectors[i], part);
        }
    }

    /// @notice Hand a call this contract does not implement to the part that claims
    ///         it. The part's code runs against THIS contract's storage and balance,
    ///         so from the outside there is still one Arena at one address.
    ///
    ///         An unclaimed selector reverts. Falling through quietly would let a
    ///         caller believe a duel started, or a deposit landed, when neither
    ///         happened.
    fallback() external payable {
        address part = partOf[msg.sig];
        if (part == address(0)) revert ArenaTypes.NoPart(msg.sig);
        // Scratch space is taken from above the free-memory pointer rather than
        // from offset 0, purely so this block can be declared memory-safe. The
        // compiler's IR pipeline switches off a whole-contract optimisation when
        // it sees assembly that might scribble on Solidity's own memory, and
        // losing it costs about 2.6 KB across the rest of Arena — far more than
        // this function contains. Nothing is written back to the pointer because
        // every path ends in return or revert.
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let ok := delegatecall(gas(), part, ptr, calldatasize(), 0, 0)
            let len := returndatasize()
            returndatacopy(ptr, 0, len)
            switch ok
            case 0 { revert(ptr, len) }
            default { return(ptr, len) }
        }
    }
    /// @notice Set the DuelHistory sink (owner-only). Recording is best-effort and
    ///         never blocks resolution, so this can be set or updated at any time.
    function setDuelHistory(address h) external onlyOwner {
        duelHistory = h;
    }
}
