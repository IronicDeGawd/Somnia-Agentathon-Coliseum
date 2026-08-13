// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISpotPool.sol";
import "../interfaces/IBinaryPool.sol";

/// @notice Test double for a dreamDEX event-contract pool. Mirrors the real
///         surface probed on testnet 2026-08-13, including the two behaviours
///         EventDesk exists to absorb: the expiry cap, and paying fills out to
///         the caller's address rather than into the vault.
contract MockBinaryPool {
    error OrderExpiryBeyondMarket();

    BinaryPoolParams private _params;
    OrderBookParams  private _grid;
    uint64  public marketExpiryNs;
    bool    public finalized;

    mapping(bool => OrderBookLevel[]) private _levels;
    mapping(address => uint256) public vault;

    // Last order seen, so tests can assert the translation.
    uint8   public lastKind;
    uint256 public lastPrice;
    uint256 public lastQuantity;
    uint64  public lastExpiry;
    uint8   public lastOrderType;
    uint64  public lastUserData;
    uint128 public nextOrderId = 1;

    /// @dev Collateral paid out to the caller on a fill, mimicking the real pool.
    uint256 public payoutOnFill;
    address public collateralToken;

    constructor(address _collateral, address _outcomeToken, address _market, uint64 _expiryNs) {
        collateralToken = _collateral;
        _params = BinaryPoolParams({
            collateralToken: _collateral,
            market: _market,
            outcomeToken: _outcomeToken,
            yesId: 111,
            noId: 222,
            oneCollateral: 1e6,
            setBacking: 0,
            feeRecipient: address(0),
            makerFeeBpsTimes1k: 0,
            takerFeeBpsTimes1k: 0,
            maxBuilderFeeBpsTimes1k: 0,
            settlementFeeBpsTimes1k: 0,
            settlement: address(0),
            marketNonce: 1,
            finalized: false
        });
        _grid = OrderBookParams({ tickSize: 1000, minQuantity: 1000, lotSize: 1000 });
        marketExpiryNs = _expiryNs;
    }

    function getBinaryPoolParams() external view returns (BinaryPoolParams memory) { return _params; }
    function getOrderBookParameters() external view returns (OrderBookParams memory) { return _grid; }

    function setBookLevel(bool isBid, uint256 price, uint256 quantity) external {
        _levels[isBid].push(OrderBookLevel({ price: price, quantity: quantity }));
    }
    function clearBook(bool isBid) external { delete _levels[isBid]; }

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory) {
        uint256 n = _levels[isBid].length < numLevels ? _levels[isBid].length : numLevels;
        OrderBookLevel[] memory out = new OrderBookLevel[](n);
        for (uint256 i = 0; i < n; i++) out[i] = _levels[isBid][i];
        return out;
    }

    function setPayoutOnFill(uint256 amount) external { payoutOnFill = amount; }

    function placeBinaryOrder(
        uint8   kind,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint8,
        address,
        uint96,
        uint64  userData
    ) external returns (bool, uint128) {
        // The real pool's rule, and the reason EventDesk clamps.
        if (expireTimestampNs == 0 || expireTimestampNs > marketExpiryNs) revert OrderExpiryBeyondMarket();

        lastKind = kind;
        lastPrice = price;
        lastQuantity = quantity;
        lastExpiry = expireTimestampNs;
        lastOrderType = orderType;
        lastUserData = userData;

        // Fills pay the CALLER, not the vault — the behaviour EventDesk sweeps up.
        if (payoutOnFill > 0) {
            IMintableCollateral(collateralToken).mint(msg.sender, payoutOnFill);
        }
        return (true, nextOrderId++);
    }

    function cancelOrder(uint128) external {}

    function deposit(address token, uint256 amount) external {
        IMintableCollateral(token).transferFrom(msg.sender, address(this), amount);
        vault[msg.sender] += amount;
    }
    function withdraw(address token, uint256 amount) external {
        vault[msg.sender] -= amount;
        IMintableCollateral(token).transfer(msg.sender, amount);
    }
    function getWithdrawableBalance(address user, address) external view returns (uint256) {
        return vault[user];
    }
}

interface IMintableCollateral {
    function mint(address to, uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Test double for the per-window market contract.
contract MockBinaryMarket {
    bool public isResolved;
    bool public isVoided;
    uint256[] private _payouts;

    function resolve(uint256 yesNum, uint256 noNum) external {
        isResolved = true;
        _payouts = [yesNum, noNum];
    }
    function void() external {
        isVoided = true;
        _payouts = [1, 1];
    }
    function payoutNumerators() external view returns (uint256[] memory) { return _payouts; }
}

/// @notice Test double for the claims registry. Deliberately keyed by marketId,
///         which the pool never exposes — the whole reason a desk must be told
///         its marketId at bind time.
contract MockMarketsModule {
    address public collateral;
    address public outcomeToken;
    mapping(bytes32 => uint256) public payoutPerContract;   // 0 = losing side
    mapping(bytes32 => uint256) public yesIdOf;
    mapping(bytes32 => bool) public known;

    constructor(address _collateral, address _outcomeToken) {
        collateral = _collateral;
        outcomeToken = _outcomeToken;
    }

    function setPayout(bytes32 marketId, uint256 yesId, uint256 perContract) external {
        payoutPerContract[marketId] = perContract;
        yesIdOf[marketId] = yesId;
        known[marketId] = true;
    }

    function redeem(uint32, bytes32, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external {
        require(known[marketId], "unknown market");
        require(outcomeIdx == 0, "only YES held");
        // The registry pulls the outcome tokens under its operator grant.
        MockOutcomeToken(outcomeToken).burnFrom(msg.sender, yesIdOf[marketId], amount);
        uint256 owed = (amount * payoutPerContract[marketId]) / 1e6;
        if (owed > 0) IMintableCollateral(collateral).mint(msg.sender, owed);
    }
}

/// @notice Test double for the ERC-6909 outcome-token singleton.
contract MockOutcomeToken {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool))    public isOperator;

    function setOperator(address spender, bool approved) external returns (bool) {
        isOperator[msg.sender][spender] = approved;
        return true;
    }
    function mint(address to, uint256 id, uint256 amount) external { balanceOf[to][id] += amount; }

    /// @dev Used by the claims registry, which must hold an operator grant.
    function burnFrom(address owner_, uint256 id, uint256 amount) external {
        require(isOperator[owner_][msg.sender], "not operator");
        balanceOf[owner_][id] -= amount;
    }
}

/// @notice tUSDC stand-in with the open faucet the real testnet token has.
contract MockFaucetToken {
    string public constant symbol = "tUSDC";
    uint8  public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public faucetCalls;

    function faucet(uint256 amount) external { balanceOf[msg.sender] += amount; faucetCalls++; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}
