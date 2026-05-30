// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SwapFallback
/// @notice Fallback STT -> USDso swap for the Coliseum testnet.
///
/// Why this exists:
///   - dreamDEX testnet has no protocol market maker. The SOMI/USDso BID side
///     is structurally empty for long stretches because the yield-bearing
///     incentive doesn't accrue on testnet. Mainnet has a Gnosis Safe MM bot
///     that seeds both sides; testnet does not.
///   - The frontend tries the real market 3 times before falling back here.
///   - One-shot per address, capped at 1 USDso, so any new user can run at
///     least one Matchmaker tier-3 duel (halfDeposit(3) = 0.9548 USDso).
///
/// Mechanics:
///   - User sends STT via fallbackSwap().
///   - Contract sends back up to MAX_USDSO_PER_USER (= 1 USDso) of USDso.
///   - Required STT-in is set by owner via setSttPerUsdso (default 7e18,
///     i.e. 7 STT per 1 USDso — well above mid so the reserve doesn't bleed).
///   - One claim per address, lifetime. To raise that, owner can call
///     resetClaim(addr) (for accidental claims only).
///   - Owner can sweep collected STT (used to fund the seeder bot) and
///     top up USDso reserves.
///
/// Security:
///   - usdsoReceivedBy state set BEFORE the external transfer (CEI).
///   - No reentrancy via STT in (msg.value is finalised before the call).
///   - Owner-only sweep/refund/setRate; cannot grant USDso beyond reserve.
///   - Receive() accepts plain STT donations for the seeder budget.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SwapFallback {
    address public owner;
    IERC20 public immutable USDSO;

    /// @notice Cap of USDso any single address can ever receive from this contract.
    uint256 public constant MAX_USDSO_PER_USER = 1e18;

    /// @notice Required STT (in wei) per 1 USDso. Owner-tunable.
    uint256 public sttPerUsdso;

    /// @notice Minimum STT a fallbackSwap() call must include.
    uint256 public minSttIn;

    /// @notice Total USDso this address has received via fallbackSwap() over its lifetime.
    mapping(address => uint256) public usdsoReceivedBy;

    event FallbackSwap(address indexed user, uint256 sttIn, uint256 usdsoOut);
    event Funded(address indexed from, uint256 sttIn);
    event SttSwept(address indexed to, uint256 amount);
    event UsdsoRefunded(address indexed to, uint256 amount);
    event RateUpdated(uint256 newSttPerUsdso, uint256 newMinSttIn);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event ClaimReset(address indexed user);

    error NotOwner();
    error AmountTooLow();
    error AlreadyClaimed();
    error InsufficientReserve();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _usdso, uint256 _sttPerUsdso, uint256 _minSttIn) {
        if (_usdso == address(0)) revert ZeroAddress();
        owner = msg.sender;
        USDSO = IERC20(_usdso);
        sttPerUsdso = _sttPerUsdso == 0 ? 7e18 : _sttPerUsdso;
        minSttIn = _minSttIn == 0 ? 1e18 : _minSttIn;
    }

    /// @notice User-facing fallback: pay STT, receive up to 1 USDso, one-shot per address.
    /// Excess STT (beyond what was needed to mint MAX_USDSO_PER_USER at the current rate)
    /// stays in the contract and funds the seeder.
    function fallbackSwap() external payable {
        if (msg.value < minSttIn) revert AmountTooLow();

        uint256 already = usdsoReceivedBy[msg.sender];
        if (already >= MAX_USDSO_PER_USER) revert AlreadyClaimed();

        // owed = (msg.value / sttPerUsdso) * 1 USDso, capped at remaining.
        // sttPerUsdso is wei-per-1e18-USDso, so:
        //   usdsoOut = msg.value * 1e18 / sttPerUsdso
        uint256 owed = (msg.value * 1e18) / sttPerUsdso;
        uint256 remaining = MAX_USDSO_PER_USER - already;
        uint256 grant = owed < remaining ? owed : remaining;

        if (grant == 0) revert AmountTooLow();
        if (USDSO.balanceOf(address(this)) < grant) revert InsufficientReserve();

        // CEI: state first, transfer last.
        usdsoReceivedBy[msg.sender] = already + grant;

        if (!USDSO.transfer(msg.sender, grant)) revert TransferFailed();

        emit FallbackSwap(msg.sender, msg.value, grant);
    }

    // ─────────────────────── Owner ───────────────────────

    /// @notice Sweep all collected STT to a target address (typically the seeder bot).
    function sweepStt(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) revert AmountTooLow();
        (bool ok, ) = to.call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit SttSwept(to, bal);
    }

    /// @notice Pull USDso back to the owner (e.g. to consolidate reserves).
    function refundUsdso(uint256 amount) external onlyOwner {
        if (!USDSO.transfer(owner, amount)) revert TransferFailed();
        emit UsdsoRefunded(owner, amount);
    }

    /// @notice Update STT-per-USDso price and minimum STT input.
    function setRate(uint256 _sttPerUsdso, uint256 _minSttIn) external onlyOwner {
        if (_sttPerUsdso == 0 || _minSttIn == 0) revert AmountTooLow();
        sttPerUsdso = _sttPerUsdso;
        minSttIn = _minSttIn;
        emit RateUpdated(_sttPerUsdso, _minSttIn);
    }

    /// @notice Reset a single address's claim history (for accidental claims).
    function resetClaim(address user) external onlyOwner {
        usdsoReceivedBy[user] = 0;
        emit ClaimReset(user);
    }

    /// @notice Transfer ownership.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Plain STT donations for the seeder budget.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }
}
