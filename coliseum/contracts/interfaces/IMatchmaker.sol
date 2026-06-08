// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view into Matchmaker so the Bookmaker can learn a duel's two
///         human players and block them from betting on their own fight.
interface IMatchmaker {
    /// @dev Mirrors Matchmaker's public `matches` mapping getter (Match struct).
    function matches(uint256 duelId) external view returns (
        address playerA,
        address playerB,
        uint256 totalPot,
        bool    recovered,
        bool    settledA,
        bool    settledB
    );
}
