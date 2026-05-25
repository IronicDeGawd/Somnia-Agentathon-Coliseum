// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBookmaker {
    function notifyDuelResolved(uint256 duelId, uint8 winnerId) external;
}
