// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct OrderBookLevel {
    uint256 price;
    uint256 quantity;
}

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

    // Verified 7-tuple on Somnia testnet 2026-05-26.
    function getPoolParams() external view returns (
        address baseToken,
        address quoteToken,
        uint256 makerFeeBpsTimes1k,
        uint256 takerFeeBpsTimes1k,
        uint256 tickSize,
        uint256 minQuantity,
        uint256 lotSize
    );

    // NOTE: getMarkPrice() does NOT exist on the real dreamDEX testnet pool.
    // Use getBookLevels(true,1) + getBookLevels(false,1) and compute midpoint.

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory);
}
