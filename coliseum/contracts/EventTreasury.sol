// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IBinaryPool.sol";

/// @title  EventTreasury
/// @notice TESTNET ONLY. Holds the collateral that event-contract desks trade
///         with, and hands it out on request.
///
/// Why it exists: on testnet, dreamDEX event contracts settle in **tUSDC**,
/// a different token from Coliseum's USDso with no swap route between them.
/// tUSDC has an open faucet; USDso does not. Rather than teach EventDesk about
/// faucets — which would make it revert on mainnet, where the collateral IS
/// USDso — the testnet-only part lives here and the desk simply receives
/// collateral from whoever is funding it.
///
///     testnet   EventTreasury.fundDesk()  ──►  EventDesk.fund()
///     mainnet   Arena's own USDso path    ──►  EventDesk.fund()
///
/// This contract is not deployed to mainnet.
///
/// Sizing, so nobody over-thinks the budget: the event minimum trade is 0.001
/// collateral, so a 15-round duel across two event pools costs roughly
/// `2 fighters × 15 rounds × 0.002 = 0.06`. One `refill` of 10,000 covers well
/// over a hundred thousand duels. Spend is one-way and bounded by the balance,
/// the same shape as the seeder bot's fixed budget.
contract EventTreasury {

    /// @dev The token's faucet reverts above this per call — measured, not guessed.
    uint256 public constant FAUCET_MAX_PER_CALL = 10_000e6;

    address public owner;
    ITestCollateral public immutable collateral;

    mapping(address => bool) public approvedDesk;

    error NotOwner();
    error NotApproved();
    error ZeroAmount();
    error TooManyChunks();

    event Refilled(uint256 amount, uint256 calls);
    event DeskApproved(address indexed desk, bool approved);
    event DeskFunded(address indexed desk, uint256 amount);
    event OwnerChanged(address indexed newOwner);

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address _collateral) {
        owner = msg.sender;
        collateral = ITestCollateral(_collateral);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice Top the treasury up from the token's open faucet, in as many
    ///         chunks as the per-call cap requires.
    /// @dev    Permissionless on purpose — the faucet is public anyway, and this
    ///         only ever moves value *into* the treasury. Chunk count is bounded
    ///         so a fat-fingered amount cannot run out of gas mid-loop.
    function refill(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 chunks = (amount + FAUCET_MAX_PER_CALL - 1) / FAUCET_MAX_PER_CALL;
        if (chunks > 20) revert TooManyChunks();

        uint256 remaining = amount;
        for (uint256 i = 0; i < chunks; i++) {
            uint256 take = remaining > FAUCET_MAX_PER_CALL ? FAUCET_MAX_PER_CALL : remaining;
            collateral.faucet(take);
            remaining -= take;
        }
        emit Refilled(amount, chunks);
    }

    function approveDesk(address desk, bool approved) external onlyOwner {
        approvedDesk[desk] = approved;
        emit DeskApproved(desk, approved);
    }

    /// @notice Give an approved desk collateral to trade with. The desk pulls it
    ///         via `transferFrom` inside its own `fund`, so the allowance is
    ///         granted and consumed in one transaction and never left standing.
    function fundDesk(address desk, uint256 amount) external onlyOwner {
        if (!approvedDesk[desk]) revert NotApproved();
        if (amount == 0) revert ZeroAmount();
        collateral.approve(desk, amount);
        IEventDeskFunding(desk).fund(amount);
        collateral.approve(desk, 0);
        emit DeskFunded(desk, amount);
    }

    /// @notice Recover the treasury's balance.
    function sweep(address to, uint256 amount) external onlyOwner {
        collateral.transfer(to, amount);
    }

    function balance() external view returns (uint256) {
        return collateral.balanceOf(address(this));
    }
}

interface IEventDeskFunding {
    function fund(uint256 amount6) external;
}
