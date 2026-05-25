// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISpotPool {
    function deposit(address token, uint256 amount) external;

    function depositNative() external payable;

    function withdraw(address token, uint256 amount) external;

    function getWithdrawableBalance(address user, address token) external view returns (uint256);

    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external returns (bool success, uint128 orderId);

    function cancelOrder(uint128 orderId) external;

    function getPoolParams() external view returns (uint256 tickSize, uint256 minQuantity, uint256 lotSize);
}
