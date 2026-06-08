// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal stand-in for Matchmaker in Bookmaker tests. Exposes the same
///         `matches(duelId)` public-getter shape the Bookmaker reads, plus a
///         setter so tests can mark a duel's two players.
contract MockMatchmaker {
    struct Match {
        address playerA;
        address playerB;
        uint256 totalPot;
        bool    recovered;
        bool    settledA;
        bool    settledB;
    }

    mapping(uint256 => Match) public matches;

    function setPlayers(uint256 duelId, address a, address b) external {
        matches[duelId].playerA = a;
        matches[duelId].playerB = b;
    }
}
