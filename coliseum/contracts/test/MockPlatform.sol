// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISomniaAgents.sol";

contract MockPlatform is IAgentRequester {
    uint256 private _nextId = 1;

    struct LastCall {
        uint256 agentId;
        address callbackAddress;
        bytes4  callbackSelector;
        bytes   payload;
        uint256 value;
    }
    LastCall public lastCall;

    mapping(uint256 => bool) private _requests;

    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId) {
        requestId = _nextId++;
        _requests[requestId] = true;
        lastCall = LastCall({
            agentId: agentId,
            callbackAddress: callbackAddress,
            callbackSelector: callbackSelector,
            payload: payload,
            value: msg.value
        });
    }

    function getRequestDeposit() external pure returns (uint256) {
        return 0.03 ether;
    }

    function hasRequest(uint256 requestId) external view returns (bool) {
        return _requests[requestId];
    }

    function getRequest(uint256 requestId) external view returns (Request memory r) {
        r.id = requestId;
    }

    function dispatchSuccess(
        address callback,
        uint256 requestId,
        bytes4 selector,
        int256 result
    ) external {
        Response[] memory responses = new Response[](1);
        responses[0].result = abi.encode(result);
        responses[0].status = ResponseStatus.Success;

        Request memory req;
        req.id = requestId;

        bytes memory data = abi.encodeWithSelector(
            selector,
            requestId,
            responses,
            ResponseStatus.Success,
            req
        );
        // msg.sender inside callback will be this contract (platform)
        (bool ok, bytes memory ret) = callback.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function dispatchFailure(
        address callback,
        uint256 requestId,
        bytes4 selector,
        ResponseStatus status
    ) external {
        Response[] memory responses = new Response[](0);
        Request memory req;
        req.id = requestId;

        bytes memory data = abi.encodeWithSelector(
            selector,
            requestId,
            responses,
            status,
            req
        );
        (bool ok, bytes memory ret) = callback.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function dispatchSuccessWithRaw(
        address callback,
        uint256 requestId,
        bytes4 selector,
        int256 rawResult
    ) external {
        this.dispatchSuccess(callback, requestId, selector, rawResult);
    }
}
