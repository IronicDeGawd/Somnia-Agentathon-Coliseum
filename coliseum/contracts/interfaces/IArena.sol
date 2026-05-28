// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArena {
    function activeDuelId() external view returns (uint256);
    function nextDuelId()   external view returns (uint256);

    // Field order matches Arena.Duel struct:
    //   fighterA, fighterB, creator, startBlock, lastTurnBlock,
    //   completedCallbacks, turns, poolMask, status, initialUsdsoPerFighter, fundsRecovered
    function duels(uint256 duelId) external view returns (
        uint8   fighterA,
        uint8   fighterB,
        address creator,
        uint256 startBlock,
        uint256 lastTurnBlock,
        uint16  completedCallbacks,
        uint16  turns,
        uint8   poolMask,
        uint8   status,
        uint256 initialUsdsoPerFighter,
        bool    fundsRecovered
    );

    function startDuel(uint8 fighterA, uint8 fighterB, uint16 turns) external returns (uint256 duelId);
    function finalizeDuel(uint256 duelId) external;
    function recoverFunds(uint256 duelId) external;
    function minDepositFor(uint16 turns) external view returns (uint256);
}
