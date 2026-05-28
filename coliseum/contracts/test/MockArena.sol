// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockArena {
    uint256 public activeDuelId;
    uint256 public nextDuelId = 1;

    struct DuelData {
        uint8   fighterA;
        uint8   fighterB;
        address creator;
        uint256 startBlock;
        uint256 lastTurnBlock;
        uint16  completedCallbacks;
        uint16  turns;
        uint8   poolMask;
        uint8   status;
        uint256 initialUsdsoPerFighter;
    }

    mapping(uint256 => DuelData) private _duels;

    function setDuelStatus(uint256 duelId, uint8 status) external {
        _duels[duelId].status = status;
    }

    function setActiveDuelId(uint256 duelId) external {
        activeDuelId = duelId;
    }

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
        uint256 initialUsdsoPerFighter
    ) {
        DuelData storage d = _duels[duelId];
        return (
            d.fighterA,
            d.fighterB,
            d.creator,
            d.startBlock,
            d.lastTurnBlock,
            d.completedCallbacks,
            d.turns,
            d.poolMask,
            d.status,
            d.initialUsdsoPerFighter
        );
    }
}
