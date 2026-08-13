// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/ArenaTypes.sol";
import "./interfaces/IFighterRegistry.sol";

/// @title ArenaStorage
/// @notice The single declaration of everything Arena remembers.
///
///         Arena is being split into a router that holds the funds and several
///         parts reached by delegatecall, because one contract can no longer fit
///         under the 24576-byte deploy limit. Delegatecall runs a part's code
///         against the ROUTER's storage, so every part must agree, slot for slot,
///         on where each value lives. The only way to guarantee that is to
///         declare it exactly once, here, and have the router and every part
///         inherit this and declare no state of their own.
///
///         Rules for changing this file:
///           - APPEND new variables at the end. Never reorder, never delete.
///           - No part may add state. If a part needs to remember something, it
///             belongs here.
///           - Nothing here may be `immutable`. An immutable is compiled into the
///             bytecode of the contract that declares it, so a part reached by
///             delegatecall would read its OWN copy — blank, because parts are
///             deployed without meaningful constructor arguments. The five values
///             that used to be immutable (USDSO, the three real pools, the
///             platform address, the registry) are ordinary storage for exactly
///             this reason.
abstract contract ArenaStorage {

    // ─── Constants ────────────────────────────────────────────────────────────
    // Constants occupy no storage slot; they are compiled into whichever code
    // reads them. They live here so every part shares one definition.

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    uint256 public constant REACTIVITY_FUND_MIN = 33 ether;

    /// @notice Platform fee scales with duel length to track LLM inference cost,
    ///         which grows with turns (≈0.24 STT/move × 2 fighters × turns). Flat
    ///         fees over-charge short duels and under-charge long ones, so the fee
    ///         is hybrid: fee = base + perTurn × turns (18-decimal USDso).
    ///         e.g. turns=3 → 0.8, turns=6 → 1.1, turns=9 → 1.4, turns=15 → 2.0.
    uint256 public constant PLATFORM_FEE_BASE     = 0.5e18;
    uint256 public constant PLATFORM_FEE_PER_TURN = 0.1e18;

    uint64  public constant MAX_EXPIRE_OFFSET_SEC          = 7 days;
    uint256 public constant LLM_AGENT_ID                   = 12847293847561029384;
    uint256 public constant FIGHTER_DEPOSIT_TOPUP          = 0.07 ether;
    uint256 public constant FIGHTER_REQUEST_DEADLINE_SEC   = 15 minutes;

    /// @notice If no turn has advanced for this many blocks, owner may call emergencyFinalize.
    uint256 public constant EMERGENCY_FINALIZE_BLOCKS = 1000;

    /// @notice Hard ceiling on maxActiveDuels. Each running duel burns STT on two
    ///         inferences per turn out of one shared balance, so the owner is not
    ///         free to raise the cap arbitrarily — a dry Arena silently produces
    ///         all-Hold duels, which now resolve as draws.
    uint16 public constant MAX_ACTIVE_CEILING = 8;

    // ─── Deployment wiring ────────────────────────────────────────────────────
    // Set once at construction. Ordinary storage rather than immutable — see the
    // contract-level note above.

    address public USDSO;
    address public POOL_WETH;
    address public POOL_WBTC;
    address public POOL_SOMI;
    address public PLATFORM_ADDR;
    IFighterRegistry public registry;
    uint256 public TURN_INTERVAL_BLOCKS;

    // ─── Vault state ──────────────────────────────────────────────────────────

    // Simulated market pool set — owner-set post-deploy (address(0) until then).
    // Duels created with simulated == true route here instead of the real pools.
    address public SIM_POOL_WETH;
    address public SIM_POOL_WBTC;
    address public SIM_POOL_SOMI;
    bool    public simPoolsSet;
    address public owner;
    uint256 public subscriptionId;
    uint256 public accruedFees;

    /// @notice Sum of all un-recovered duel pots currently escrowed in this
    ///         contract's USDso balance. withdrawFees() never dips below this, so
    ///         platform-fee withdrawal can never touch depositor principal.
    ///         Incremented in startDuel, decremented in recoverFunds.
    uint256 public escrowedPot;

    /// @notice Running total of USDso the OWNER has seeded into pool vaults via
    ///         fundPools(). Tracked separately from user duel deposits so the
    ///         owner can withdraw their own seed liquidity without touching
    ///         depositor funds. Incremented in fundPools, decremented in
    ///         ownerWithdrawSeed.
    uint256 public seedLiquidity;

    mapping(address => ArenaTypes.PoolMeta) public poolMeta;

    // ─── Duel state ───────────────────────────────────────────────────────────

    mapping(uint256 => ArenaTypes.Duel) public duels;
    uint256 public nextDuelId = 1;

    /// @notice Every duel currently running. Order is not stable — _resolveDuel
    ///         removes by swap-and-pop, so the last id takes the resolved one's place.
    ///         Read it through getActiveDuelIds() — kept internal so solc does not
    ///         also emit a per-index auto-getter, which Arena has no room for.
    uint256[] internal activeDuelIds;

    /// @dev duelId → index+1 in activeDuelIds (0 = not active), for O(1) removal.
    mapping(uint256 => uint256) internal _activeIndex;

    /// @notice How many duels may run at once. Owner-settable up to MAX_ACTIVE_CEILING.
    uint16 public maxActiveDuels = 3;

    /// @notice USDso escrow held for each duel's creator (the pot, fee excluded).
    ///         Set on startDuel, paid out (and zeroed) on recoverFunds. recoverFunds
    ///         pays the creator from this contract's OWN balance, capped by duelPot,
    ///         so one duel can never drain another's deposit or the owner seed.
    mapping(uint256 => uint256) public duelPot;

    /// @notice The three pools a duel trades on, recorded once at startDuel.
    ///         Previously derived from duel.simulated against two hard-coded sets,
    ///         which cannot express a pool set that only exists for one duel (an
    ///         event window opens at a fresh address every few minutes). Recording
    ///         per duel also closes audit item M1: a pool's cached trading rules can
    ///         be refreshed without a redeploy, and running duels keep the set they
    ///         started on. Order is [WETH, WBTC, SOMI] to match the bit ordering.
    mapping(uint256 => address[3]) internal duelPools;

    // poolAddress → duelId → fighterId → balance
    mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) public fighterBalances;

    mapping(uint256 => ArenaTypes.PendingTurn) public pendingTurns;  // requestId → turn

    /// @notice Mark price snapshot per duel per pool, written at the start of each turn.
    ///         emergencyFinalize uses this instead of live prices to prevent owner-timed
    ///         price manipulation. Normal finalizeDuel still uses live prices (safe because
    ///         all callbacks are complete — no further trading can move the book).
    mapping(uint256 => mapping(address => uint256)) public duelMarkSnapshots;

    /// @notice Previous-turn mark price per duel/pool. Carried forward from
    ///         duelMarkSnapshots before each turn's snapshot overwrites it, so the
    ///         market summary handed to fighters can show the move since last turn.
    mapping(uint256 => mapping(address => uint256)) public duelPrevMarkSnapshots;

    /// @notice Optional history sink. When set, _resolveDuel records each duel's
    ///         outcome here (best-effort). Configured post-deploy via setDuelHistory.
    address public duelHistory;

    /// @notice Which part answers each function. The router looks a call's
    ///         selector up here and hands the work to that part, which runs
    ///         against this contract's storage. Public so the wiring is auditable
    ///         from outside without replaying logs.
    mapping(bytes4 => address) public partOf;

    // ─── Shared behaviour ─────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert ArenaTypes.NotOwner();
        _;
    }

    /// @notice Turn-scaled platform fee collected at startDuel. Pure, and read by
    ///         Matchmaker before it quotes a player, so it stays reachable directly.
    function platformFee(uint16 turns) public pure returns (uint256) {
        return PLATFORM_FEE_BASE + PLATFORM_FEE_PER_TURN * uint256(turns);
    }

    /// @notice The pool set a duel is bound to. Kept as a function rather than a
    ///         bare mapping read so the three-slot load is emitted once instead of
    ///         at every call site — Arena has no room for the inlined copies.
    function _duelPools(uint256 duelId) internal view returns (address[3] memory) {
        return duelPools[duelId];
    }

    /// @notice Resolve a pool set from the real/simulated flag alone. Only correct
    ///         where no duel exists yet — quoting a deposit before one is created.
    ///         Anything holding a duel must use _duelPools instead.
    ///         Returned order is [WETH, WBTC, SOMI] to match the bit ordering.
    function _pools(bool simulated) internal view returns (address[3] memory) {
        if (simulated) return [SIM_POOL_WETH, SIM_POOL_WBTC, SIM_POOL_SOMI];
        return [POOL_WETH, POOL_WBTC, POOL_SOMI];
    }
}
