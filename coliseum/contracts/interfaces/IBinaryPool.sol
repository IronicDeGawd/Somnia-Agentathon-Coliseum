// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ISpotPool.sol";

/// @notice dreamDEX event-contract (binary Up/Down) pool.
///         Verified against Somnia testnet 2026-08-13 — see context/plan/event-contracts.md.
///
///         Reads overlap with ISpotPool (`getBookLevels`, `getWithdrawableBalance`,
///         `deposit`, `withdraw` are byte-identical signatures) but writes do NOT:
///         a binary pool takes `placeBinaryOrder`, and the generic `placeOrder`
///         reverts with UseBinaryPlacement.
struct BinaryPoolParams {
    address collateralToken;
    address market;
    address outcomeToken;
    uint256 yesId;
    uint256 noId;
    uint256 oneCollateral;      // 1e6 on testnet — one whole contract
    uint256 setBacking;
    address feeRecipient;
    uint256 makerFeeBpsTimes1k;
    uint256 takerFeeBpsTimes1k;
    uint256 maxBuilderFeeBpsTimes1k;
    uint256 settlementFeeBpsTimes1k;
    address settlement;
    uint64  marketNonce;
    bool    finalized;
}

struct OrderBookParams {
    uint256 tickSize;
    uint256 minQuantity;
    uint256 lotSize;
}

interface IBinaryPool {
    /// @param kind 0=BUY_YES 1=SELL_YES 2=BUY_NO 3=SELL_NO
    /// @param orderType 0=LIMIT 1=FILL_OR_KILL 2=IOC 3=POST_ONLY
    /// @dev Reverts OrderExpiryBeyondMarket (0xd3dea628) unless
    ///      0 < expireTimestampNs <= marketExpiryNs().
    function placeBinaryOrder(
        uint8   kind,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint8   selfMatchingOption,
        address builder,
        uint96  builderFeeBpsTimes1k,
        uint64  userData
    ) external returns (bool success, uint128 orderId);

    function cancelOrder(uint128 orderId) external;

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory);
    function getBinaryPoolParams() external view returns (BinaryPoolParams memory);
    function getOrderBookParameters() external view returns (OrderBookParams memory);
    function marketExpiryNs() external view returns (uint64);
    function finalized() external view returns (bool);

    function deposit(address token, uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
    function getWithdrawableBalance(address user, address token) external view returns (uint256);
}

/// @notice The per-window market contract that carries the settlement outcome.
interface IBinaryMarket {
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
    /// @dev One entry per outcome; index 0 = YES/Up. One-hot when resolved,
    ///      equal halves when voided.
    function payoutNumerators() external view returns (uint256[] memory);
}

/// @notice ERC-6909 singleton holding every market's YES/NO as token ids.
interface IOutcomeToken6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function isOperator(address owner, address spender) external view returns (bool);
    function setOperator(address spender, bool approved) external returns (bool);
}

/// @notice Minimal ERC-20 surface the desk needs from its collateral token.
///         Deliberately free of anything testnet-specific.
interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Testnet collateral only. `faucet` is open and unpermissioned but
///         **capped at 10,000 per call** (measured on Somnia testnet
///         2026-08-13). Mainnet collateral is USDso and has no faucet, which is
///         why this lives behind EventTreasury and never inside EventDesk.
interface ITestCollateral is IERC20Like {
    function faucet(uint256 amount) external;
}
