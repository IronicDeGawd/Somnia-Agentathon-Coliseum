// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/FighterPrompts.sol";

contract FighterRegistry {
    struct Fighter {
        string name;
        string tagline;
        string systemPrompt;
        uint8 aggression;
        uint8 patience;
        uint8 risk;
    }

    error FighterOutOfBounds(uint8 id);
    error StatOutOfRange(uint8 id, string stat, uint8 value);
    error NotOwner();

    mapping(uint8 => Fighter) public fighters;
    uint8 public constant FIGHTER_COUNT = 6;

    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        _set(0, "The Degen",        "Send it. Always.",                    FighterPrompts.degen(),        5, 1, 5);
        _set(1, "The Whale",        "Size matters. Move markets.",         FighterPrompts.whale(),        4, 3, 4);
        _set(2, "The Quant",        "Mean reversion or nothing.",          FighterPrompts.quant(),        1, 5, 2);
        _set(3, "The Diamond Hand", "Never sell. Buy the dip.",            FighterPrompts.diamondHand(), 1, 5, 3);
        _set(4, "The Scalper",      "1% x 1000 = victory.",               FighterPrompts.scalper(),      4, 1, 3);
        _set(5, "The Contrarian",   "Whatever they're doing, do opposite.", FighterPrompts.contrarian(),  3, 3, 3);
    }

    function getFighter(uint8 id) external view returns (Fighter memory) {
        if (id >= FIGHTER_COUNT) revert FighterOutOfBounds(id);
        return fighters[id];
    }

    /// @notice Owner-only full replace of a fighter's profile (reuses _set validation).
    function setFighter(
        uint8 id,
        string calldata name,
        string calldata tagline,
        string calldata systemPrompt,
        uint8 aggression,
        uint8 patience,
        uint8 risk
    ) external onlyOwner {
        if (id >= FIGHTER_COUNT) revert FighterOutOfBounds(id);
        _set(id, name, tagline, systemPrompt, aggression, patience, risk);
    }

    /// @notice Owner-only prompt-only tweak — the common case for live tuning.
    ///         Lets us iterate on fighter behaviour without redeploying.
    function setPrompt(uint8 id, string calldata systemPrompt) external onlyOwner {
        if (id >= FIGHTER_COUNT) revert FighterOutOfBounds(id);
        fighters[id].systemPrompt = systemPrompt;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function _set(
        uint8 id,
        string memory name,
        string memory tagline,
        string memory systemPrompt,
        uint8 aggression,
        uint8 patience,
        uint8 risk
    ) private {
        if (aggression > 5) revert StatOutOfRange(id, "aggression", aggression);
        if (patience > 5) revert StatOutOfRange(id, "patience", patience);
        if (risk > 5) revert StatOutOfRange(id, "risk", risk);
        fighters[id] = Fighter(name, tagline, systemPrompt, aggression, patience, risk);
    }
}
