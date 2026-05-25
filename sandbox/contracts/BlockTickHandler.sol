// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

/// @dev Tiny handler used to verify the on-chain BlockTick subscription pipeline.
/// The base contract (SomniaEventHandler) implements supportsInterface and
/// restricts access to the precompile — we only override _onEvent.
contract BlockTickHandler is SomniaEventHandler {
    uint256 public tickCount;
    uint64  public lastBlockNumber;

    event Ticked(uint64 indexed blockNumber, uint256 indexed tickCount);

    function _onEvent(
        address /*emitter*/,
        bytes32[] calldata eventTopics,
        bytes calldata /*data*/
    ) internal override {
        uint64 blockNumber = uint64(uint256(eventTopics[1]));
        tickCount += 1;
        lastBlockNumber = blockNumber;
        emit Ticked(blockNumber, tickCount);
    }

    receive() external payable {}
}
