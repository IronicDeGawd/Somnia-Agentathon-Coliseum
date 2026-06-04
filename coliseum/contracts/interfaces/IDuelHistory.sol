// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDuelHistory
/// @notice Sink the Arena calls once per duel at resolution to record the
///         canonical outcome (win/loss + final portfolio values for PnL).
interface IDuelHistory {
    function onResolved(
        uint256 duelId,
        uint8 fighterA,
        uint8 fighterB,
        uint8 winnerSlot,
        uint256 valueA,
        uint256 valueB,
        uint256 initialPerFighter
    ) external;
}
