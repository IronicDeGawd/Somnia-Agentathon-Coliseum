// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentRequester, ILLMInferenceAgent, Response, Request, ResponseStatus} from "./interfaces/ISomniaAgents.sol";

/// @title PromptProbe — throwaway harness for measuring Somnia LLM agent behaviour.
/// @notice Not part of the game. Exists to answer three questions that cannot be
///         answered off-chain, because the platform prunes finalized requests
///         (getRequest reverts) and the agent adds no documented output wrapper:
///
///           1. Is inferNumber's result really "extract integer, then clamp"?
///              If so, any extracted value > maxValue lands on maxValue — which in
///              Arena's 0..6 range is SellSOMI, the exact action that failed duel 21.
///           2. What does the extractor pick when the model answers in prose?
///           3. Does inferString's allowedValues actually constrain the output set?
///
///         Deploy, fund with STT, fire probes, read results, then discard.
contract PromptProbe {
    address public immutable PLATFORM;
    uint256 public immutable AGENT_ID;
    address public owner;

    uint256 public constant DEPOSIT_TOPUP = 0.07 ether;

    struct Probe {
        string  label;
        bool    isString;      // true = inferString, false = inferNumber
        bool    answered;
        uint8   status;        // ResponseStatus as delivered
        uint256 responseCount;
        bytes   rawResult;     // undecoded bytes from responses[0]
        int256  asInt;         // decoded when 32 bytes
        string  asString;      // decoded when it looks like a string
    }

    mapping(uint256 => Probe) public probes;   // requestId => Probe
    uint256[] public requestIds;

    event ProbeSent(uint256 indexed requestId, string label);
    event ProbeAnswered(uint256 indexed requestId, string label, uint8 status, bytes rawResult, int256 asInt);
    event ProbeFailed(string label, string reason);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address platform, uint256 agentId) {
        PLATFORM = platform;
        AGENT_ID = agentId;
        owner    = msg.sender;
    }

    receive() external payable {}

    function _send(bytes memory payload, string memory label, bool isString) internal {
        IAgentRequester platform = IAgentRequester(PLATFORM);
        uint256 deposit = platform.getRequestDeposit() + DEPOSIT_TOPUP * 3;
        if (address(this).balance < deposit) {
            emit ProbeFailed(label, "insufficient stt");
            return;
        }
        try platform.createRequest{value: deposit}(
            AGENT_ID, address(this), this.onResponse.selector, payload
        ) returns (uint256 requestId) {
            probes[requestId].label    = label;
            probes[requestId].isString = isString;
            requestIds.push(requestId);
            emit ProbeSent(requestId, label);
        } catch {
            emit ProbeFailed(label, "createRequest reverted");
        }
    }

    /// @notice Fire an inferNumber probe with explicit bounds.
    function probeNumber(
        string calldata prompt,
        string calldata system,
        int256 minValue,
        int256 maxValue,
        bool   chainOfThought,
        string calldata label
    ) external onlyOwner {
        _send(
            abi.encodeWithSelector(
                ILLMInferenceAgent.inferNumber.selector,
                prompt, system, minValue, maxValue, chainOfThought
            ),
            label,
            false
        );
    }

    /// @notice Fire an inferString probe with a constrained answer set.
    function probeString(
        string calldata prompt,
        string calldata system,
        bool   chainOfThought,
        string[] calldata allowedValues,
        string calldata label
    ) external onlyOwner {
        _send(
            abi.encodeWithSelector(
                ILLMInferenceAgent.inferString.selector,
                prompt, system, chainOfThought, allowedValues
            ),
            label,
            true
        );
    }

    /// @notice Platform callback. Deliberately stores the RAW bytes before any
    ///         decoding, so we can see exactly what the agent returned rather
    ///         than what we expected it to return.
    function onResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory /* details */
    ) external {
        require(msg.sender == PLATFORM, "only platform");
        Probe storage p = probes[requestId];
        p.answered      = true;
        p.status        = uint8(status);
        p.responseCount = responses.length;

        if (responses.length == 0) {
            emit ProbeAnswered(requestId, p.label, p.status, "", 0);
            return;
        }
        bytes memory r = responses[0].result;
        p.rawResult = r;
        if (r.length == 32) {
            p.asInt = abi.decode(r, (int256));
        } else if (r.length > 32) {
            // Best effort: dynamic string encoding.
            p.asString = abi.decode(r, (string));
        }
        emit ProbeAnswered(requestId, p.label, p.status, r, p.asInt);
    }

    function probeCount() external view returns (uint256) { return requestIds.length; }

    function getProbe(uint256 requestId)
        external view
        returns (string memory label, bool isString, bool answered, uint8 status,
                 uint256 responseCount, bytes memory rawResult, int256 asInt, string memory asString)
    {
        Probe storage p = probes[requestId];
        return (p.label, p.isString, p.answered, p.status, p.responseCount, p.rawResult, p.asInt, p.asString);
    }

    function sweep() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}
