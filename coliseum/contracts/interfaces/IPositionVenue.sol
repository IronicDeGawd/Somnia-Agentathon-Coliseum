// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A venue that HOLDS the position itself rather than handing Arena a
///         token to hold.
///
///         The spot venues deliver a fill to Arena as an ERC-20, so "can I
///         deliver what this fighter wants to sell?" is answered by reading that
///         token's balance. A prediction desk does not work that way: the
///         position is an ERC-6909 id owned by the DESK, and the token address
///         the venue advertises for it is an uninitialised proxy that answers
///         nothing at all. Asking it a balance question got a refusal, Arena read
///         the refusal as "I hold none", and so no fighter was ever offered a way
///         out of a prediction — for the entire life of that market.
///
///         So the venue is asked instead. Any venue that can answer this is
///         telling Arena what it is able to hand over; one that cannot is refused
///         exactly as before.
interface IPositionVenue {
    /// @notice Position this venue can currently deliver, in Arena's 18 decimals.
    function yesBalance18() external view returns (uint256);
}
