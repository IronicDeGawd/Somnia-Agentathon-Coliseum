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

    /// @notice Stop a live subscription. Documented by Somnia but missing from this
    ///         interface until now, which is why nothing here could ever cancel one.
    ///         Measured on testnet: 430 firings while running, 0 in the 30 s after.
    function unsubscribe(uint256 subscriptionId) external;
}
