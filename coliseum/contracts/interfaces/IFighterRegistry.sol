// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFighterRegistry {
    struct Fighter {
        string name;
        string tagline;
        string systemPrompt;
        uint8 aggression;
        uint8 patience;
        uint8 risk;
    }

    function getFighter(uint8 id) external view returns (Fighter memory);

    function FIGHTER_COUNT() external view returns (uint8);
}
