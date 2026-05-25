// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Ping {
    event Pinged(address indexed caller, uint256 timestamp);

    function ping() external pure returns (string memory) {
        return "pong";
    }

    function pingAndLog() external {
        emit Pinged(msg.sender, block.timestamp);
    }
}
