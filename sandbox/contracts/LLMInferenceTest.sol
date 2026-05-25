// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/ISomniaAgents.sol";

/**
 * Smoke-test: fire one inferString call and store the result.
 * Verifies: deposit math, callback wiring, response decoding.
 *
 * Deploy → call requestInference() with correct msg.value → wait for
 * ResponseReceived event (up to ~60s).
 */
contract LLMInferenceTest {
    IAgentRequester public constant PLATFORM =
        IAgentRequester(0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776);

    uint256 public constant LLM_AGENT_ID = 12847293847561029384;
    uint256 public constant SUBCOMMITTEE_SIZE = 3;
    // 0.03 ops reserve/agent + 0.07 reward/agent, × 3 agents = 0.30 STT
    uint256 public constant PER_AGENT_PRICE = 0.07 ether;

    string public lastResponse;
    uint256 public lastRequestId;
    bool public responded;

    event ResponseReceived(uint256 indexed requestId, string response);
    event RequestFailed(uint256 indexed requestId, ResponseStatus status);

    function requiredDeposit() public view returns (uint256) {
        uint256 floor = PLATFORM.getRequestDeposit();
        return floor + PER_AGENT_PRICE * SUBCOMMITTEE_SIZE;
    }

    function requestInference() external payable returns (uint256 requestId) {
        uint256 needed = requiredDeposit();
        require(msg.value >= needed, "insufficient deposit");

        string[] memory allowedValues = new string[](3);
        allowedValues[0] = "bullish";
        allowedValues[1] = "bearish";
        allowedValues[2] = "neutral";

        bytes memory payload = abi.encodeWithSelector(
            ILLMInferenceAgent.inferString.selector,
            "Bitcoin just broke above its 200-day moving average with strong volume. What is your market sentiment?",
            "You are a crypto market analyst. Reply with exactly one word from the allowed values.",
            false,
            allowedValues
        );

        requestId = PLATFORM.createRequest{value: msg.value}(
            LLM_AGENT_ID,
            address(this),
            this.handleResponse.selector,
            payload
        );
        lastRequestId = requestId;
    }

    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory /* details */
    ) external {
        require(msg.sender == address(PLATFORM), "only platform");

        if (status == ResponseStatus.Success && responses.length > 0) {
            lastResponse = abi.decode(responses[0].result, (string));
            responded = true;
            emit ResponseReceived(requestId, lastResponse);
        } else {
            emit RequestFailed(requestId, status);
        }
    }

    receive() external payable {}
}
