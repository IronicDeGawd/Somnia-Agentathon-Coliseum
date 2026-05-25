// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import {ISomniaReactivityPrecompile} from "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaReactivityPrecompile.sol";

/// @dev Self-subscribing BlockTick handler. The constructor registers the
/// subscription with the precompile in the same TX as deploy.
contract BlockTickHandler is SomniaEventHandler {
    uint256 public tickCount;
    uint64  public lastBlockNumber;
    uint256 public subscriptionId;

    event Ticked(uint64 indexed blockNumber, uint256 indexed tickCount);

    constructor() payable {
        require(msg.value >= 32 ether, "fund with >= 32 STT");

        ISomniaReactivityPrecompile.SubscriptionData memory data =
            ISomniaReactivityPrecompile.SubscriptionData({
                eventTopics: [
                    keccak256("BlockTick(uint64)"),
                    bytes32(0),
                    bytes32(0),
                    bytes32(0)
                ],
                origin: address(0),
                caller: address(0),
                emitter: SomniaExtensions.SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS,
                handlerContractAddress: address(this),
                // onEvent(address,bytes32[],bytes) = 0x53edf33d
                handlerFunctionSelector: SomniaEventHandler.onEvent.selector,
                priorityFeePerGas: 2_000_000_000,   // 2 gwei
                maxFeePerGas:      20_000_000_000,  // 20 gwei (Somnia gas model is generous)
                gasLimit:          3_000_000,       // 3M — matches Reactivityhackathon default
                isGuaranteed: false,
                isCoalesced:  false
            });

        subscriptionId = ISomniaReactivityPrecompile(
            SomniaExtensions.SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS
        ).subscribe(data);
    }

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
