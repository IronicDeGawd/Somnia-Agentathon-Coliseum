// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISomniaReactivityPrecompile {
    struct SubscriptionData {
        bytes32[4] eventTopics;
        address    origin;
        address    caller;
        address    emitter;
        address    handlerContractAddress;
        bytes4     handlerFunctionSelector;
        uint64     priorityFeePerGas;
        uint64     maxFeePerGas;
        uint64     gasLimit;
        bool       isGuaranteed;
        bool       isCoalesced;
    }

    function subscribe(SubscriptionData calldata data) external returns (uint256 subscriptionId);
}
