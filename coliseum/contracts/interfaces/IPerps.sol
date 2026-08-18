// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ISpotPool.sol";

/// @title  IPerps
/// @notice The slices of the dreamDEX perpetual-futures protocol Coliseum calls.
///         Trimmed on purpose: the real `IPerpPool` is 656 lines and `IMarginBank`
///         1246, and importing that surface would put a hundred functions we never
///         call into every artifact.
///
/// Two declarations here look wrong and are not:
///
///  1. `getOrderBookParameters` really returns a `struct OrderBookParameters
///     { uint256 tickSize; uint256 minQuantity; uint256 lotSize; }`, and
///     `getPosition` a `struct Position { int128; uint128; int256; uint64; }`.
///     A struct whose members are all statically sized encodes as a flat tuple
///     and its canonical type string is that tuple, so the selector and the
///     returned bytes are identical either way. Declaring them unpacked avoids
///     re-declaring the protocol's structs — which would then have to be kept in
///     step by hand.
///
///  2. `placeOrder` is `payable` upstream. Calling a payable function through a
///     non-payable declaration with zero value is fine, but it is declared
///     payable here anyway so the two ABIs match exactly and nobody has to
///     wonder.
///
/// Signatures verified against `somnia-chain/somnia-dex-protocol`
/// (`src/interfaces/IPerpPool.sol`, `IOrderBook.sol`, `IMarginBank.sol`,
/// `src/perps/PerpTypes.sol`) on 2026-08-19, and exercised live by
/// `contracts/test/PerpProbe.sol` on the same day.
interface IPerpPool {
    function placeOrder(
        bool    isBid,
        uint64  userData,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs,
        uint8   orderType,
        uint8   selfMatchingOption,
        address builder,
        uint96  builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 id);

    function getBookLevels(bool isBid, uint64 numLevels) external view returns (OrderBookLevel[] memory);

    /// @dev Really `returns (OrderBookParameters memory)` — see the note above.
    function getOrderBookParameters() external view returns (
        uint256 tickSize,
        uint256 minQuantity,
        uint256 lotSize
    );

    /// @notice 10^decimals of the synthetic base asset. Derive scale from this and
    ///         never from a constant — the mistake `EventDesk` shipped with.
    function getOneBase() external view returns (uint256);

    /// @notice Non-reverting mark read. The plain `getMarkPrice()` also exists but
    ///         fails closed on a stale oracle, which would take a whole turn down.
    function tryGetMarkPrice() external view returns (bool ok, uint256 price);

    /// @notice Initial-margin factor in basis points, scaled UP with market-wide
    ///         open interest. Measured 2026-08-19: BTC sat at 1853 bps against a
    ///         configured 500 — 3.7x. Any margin arithmetic must ride on this and
    ///         never on the static config value.
    function getEffectiveIMF() external view returns (uint256);

    /// @notice True when every oracle-dependent read this market needs would
    ///         succeed. Probing it first is what makes `getEffectiveIMF` safe.
    function isPriceable() external view returns (bool);

    /// @notice Close-only. Every order except a reducing one reverts while set.
    function isRestricted() external view returns (bool);
}

interface IMarginBank {
    function deposit(uint256 amount) external;

    function withdraw(uint256 amount) external;

    /// @notice Collateral + unrealised PnL + realised + funding, sign included.
    ///         One call returns a fighter's whole score. The `try` variant is
    ///         deliberate: the reverting one fails closed on a stale oracle, and a
    ///         duel must still resolve when the oracle is down.
    function tryGetAccountEquity(address account) external view returns (bool ok, int256 equity);

    /// @notice The real free-margin figure. `getWithdrawableCollateral` is NOT it —
    ///         measured with a short open against a 25 USDso deposit it still
    ///         reported the full 25, because it ignores the initial margin an open
    ///         position needs. Take `equity - imReq` from here instead.
    function getAccountHealth(address account) external view returns (
        int256  equity,
        uint256 imReq,
        uint256 mmReq,
        uint256 cmReq
    );

    /// @dev Really `returns (Position memory)` — see the note above. `size` is
    ///      SIGNED: positive long, negative short. `lastUpdatedTimestampNs` is
    ///      deprecated upstream and unreliable; never read it.
    function getPosition(address account, address perpPool) external view returns (
        int128  size,
        uint128 avgEntryPrice,
        int256  entryFundingIndex,
        uint64  lastUpdatedTimestampNs
    );

    function getWithdrawableCollateral(address account) external view returns (uint256);

    /// @notice Every market this account currently holds a position in. The list
    ///         shrinks as positions close, so iterate a memory copy.
    function getActivePerpPools(address account) external view returns (address[] memory);

    /// @notice 0 Healthy, 1 MarginCall, 2 PartialLiquidation, 3 CloseOut.
    function getMarginStatus(address account) external view returns (uint8);
}

/// @notice What a `PerpDesk` answers about a fighter, on top of the ordinary pool
///         questions in `ISpotPool`. A perps slot cannot be described by a token
///         balance, so the things Arena needs to know — may this fighter go long,
///         may it go short, which way is it currently facing — have to be asked.
interface IPerpDesk {
    function fighterTradability(uint256 duelId, uint8 fighterId)
        external view returns (bool canLong, bool canShort);

    /// @return side -1 short, 0 flat, 1 long.
    function fighterSide(uint256 duelId, uint8 fighterId) external view returns (int8 side);

    /// @notice The perp market this desk stands in front of.
    function market() external view returns (address);

    /// @notice The registry this desk routes its orders to. Immutable on the desk, and
    ///         checked at registration: a desk built against a different registry
    ///         would send every order somewhere Arena's accounts and float do not
    ///         live, and every one would be refused for a reason visible nowhere.
    function registry() external view returns (address);
}

/// @notice The slice of `PerpAccountRegistry` that Arena itself calls. Kept as its
///         own interface so Arena never imports the registry's implementation.
interface IPerpRegistry {
    function selectMarkets(uint256 budget, uint256 salt) external view returns (address[3] memory);

    /// @notice Called by a desk, never by Arena: the market traded is the calling
    ///         desk's own, so a desk cannot reach across the board.
    function trade(
        uint256 duelId,
        uint8   fighterId,
        bool    isBid,
        uint256 price,
        uint256 quantity,
        uint64  expireTimestampNs
    ) external returns (bool ok, uint128 orderId);

    function lease(uint256 duelId, uint8 fighterId, uint256 budget) external returns (address account);

    function release(uint256 duelId, uint8 fighterId) external returns (uint256 reclaimed, bool clean);

    function equityOf(uint256 duelId, uint8 fighterId) external view returns (bool ok, int256 equity);

    function accountOf(uint256 duelId, uint8 fighterId) external view returns (address);

    function fundFloat(uint256 amount) external;

    function releaseFloat(uint256 amount, address to) external;
}

/// @notice The extra registry reads the TURN PROMPT needs, split out because they
///         serve a different purpose from the write path above: these exist so a
///         fighter can be told what its position is actually worth, rather than only
///         which way it is facing.
///
///         Reaching them through the registry rather than adding them to the desk is
///         what keeps this a library change: the desks and the registry are already
///         deployed and neither can be re-pointed, but both already expose enough to
///         find the margin bank and the fighter's own account from a desk address.
interface IPerpRegistryPrompt {
    function bank() external view returns (address);
    function marketCost(address market) external view returns (bool tradable, uint256 imPerLot);
    function freeMarginOf(address account) external view returns (uint256);
}
