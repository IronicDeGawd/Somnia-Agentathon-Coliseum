// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArena {
    function activeDuelId() external view returns (uint256);
    function nextDuelId() external view returns (uint256);

    // Field order matches Arena.Duel struct exactly:
    //   fighterA, fighterB, startBlock, lastTurnBlock,
    //   completedCallbacks, status, pool, initialUsdsoPerFighter
    function duels(uint256 duelId) external view returns (
        uint8   fighterA,
        uint8   fighterB,
        uint256 startBlock,
        uint256 lastTurnBlock,
        uint16  completedCallbacks,
        uint8   status,
        address pool,
        uint256 initialUsdsoPerFighter
    );
}
