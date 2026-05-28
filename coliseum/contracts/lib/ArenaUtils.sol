// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ArenaTypes.sol";
import "../interfaces/ISpotPool.sol";

/// @title ArenaUtils
/// @notice Pure/view helpers for the Arena system. No state, no auth.
///         Isolated here so they can be audited and unit-tested independently.
library ArenaUtils {

    // ─── Pool mask helpers ────────────────────────────────────────────────────

    function poolMaskForTurns(uint16 turns) internal pure returns (uint8) {
        if (turns == 3)  return ArenaTypes.TIER_3_MASK;
        if (turns == 6)  return ArenaTypes.TIER_6_MASK;
        if (turns == 9)  return ArenaTypes.TIER_9_MASK;
        if (turns == 15) return ArenaTypes.TIER_15_MASK;
        revert ArenaTypes.InvalidTurnCount();
    }

    function isValidTurnCount(uint16 turns) internal pure returns (bool) {
        return turns == 3 || turns == 6 || turns == 9 || turns == 15;
    }

    // ─── Minimum deposit calculation ─────────────────────────────────────────

    /// @notice Returns the minimum total USDso deposit (both fighters combined) for a given
    ///         turn count. Computes: turns × sum(minQuantity × markPrice / baseUnit) over
    ///         active pools, then doubles for two fighters. Falls back to 0 if pool has no
    ///         book data (local hardhat). Excludes platform fee — caller adds that separately.
    function minDepositFor(
        uint16 turns,
        address poolWeth,
        address poolWbtc,
        address poolSomi,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta
    ) internal view returns (uint256 total) {
        uint8 mask = poolMaskForTurns(turns);
        address[3] memory pools = [poolWeth, poolWbtc, poolSomi];
        uint8[3] memory bits = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];

        for (uint256 i = 0; i < 3; i++) {
            if (mask & bits[i] == 0) continue;
            ArenaTypes.PoolMeta storage meta = poolMeta[pools[i]];
            if (meta.minQuantity == 0) continue;
            uint256 markPrice = midMarkPrice(pools[i]);
            if (markPrice == 0) continue;
            uint256 baseUnit = 10 ** uint256(meta.baseDecimals);
            uint256 minCostPerTurn = (meta.minQuantity * markPrice) / baseUnit;
            total += minCostPerTurn * uint256(turns);
        }
        // Double for two fighters, each gets their own budget per active pool.
        total *= 2;
    }

    // ─── Mid-market price ────────────────────────────────────────────────────

    function midMarkPrice(address pool) internal view returns (uint256) {
        uint256 bid = 0;
        uint256 ask = 0;
        try ISpotPool(pool).getBookLevels(true, 1) returns (OrderBookLevel[] memory bids) {
            if (bids.length > 0) bid = bids[0].price;
        } catch {}
        try ISpotPool(pool).getBookLevels(false, 1) returns (OrderBookLevel[] memory asks) {
            if (asks.length > 0) ask = asks[0].price;
        } catch {}
        if (bid > 0 && ask > 0) return (bid + ask) / 2;
        if (bid > 0) return bid;
        if (ask > 0) return ask;
        return 0;
    }

    // ─── String helpers ───────────────────────────────────────────────────────

    function uint256ToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory buf = new bytes(78);
        uint256 len = 0;
        uint256 tmp = v;
        while (tmp > 0) { buf[len++] = bytes1(uint8(48 + (tmp % 10))); tmp /= 10; }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = buf[len - 1 - i];
        return string(out);
    }

    function actionName(uint8 a) internal pure returns (string memory) {
        if (a == 1) return "BuyWBTC";
        if (a == 2) return "SellWBTC";
        if (a == 3) return "BuyWETH";
        if (a == 4) return "SellWETH";
        if (a == 5) return "BuySOMI";
        if (a == 6) return "SellSOMI";
        return "Hold";
    }

    // ─── LLM prompt builder ──────────────────────────────────────────────────

    function buildMarketSummary(
        uint256 duelId,
        uint8   fighterId,
        ArenaTypes.Duel storage duel,
        address poolWeth,
        address poolWbtc,
        address poolSomi,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta
    ) internal view returns (string memory) {
        uint16 turnNum = duel.completedCallbacks / 2 + 1;
        string memory lastAct = actionName(duel.lastAction[fighterId]);

        string memory summary = string.concat(
            "duel ", uint256ToString(duelId),
            " turn ", uint256ToString(turnNum), "/", uint256ToString(duel.turns),
            ". last action: ", lastAct, "."
        );

        address[3] memory pools  = [poolWeth, poolWbtc, poolSomi];
        uint8[3]   memory bits   = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        string[3]  memory labels = ["WETH", "WBTC", "SOMI"];

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            summary = string.concat(summary, " ", vaultLine(
                labels[i], pools[i], duelId, fighterId,
                fighterBalances, poolMeta
            ));
        }

        summary = string.concat(summary, " Pick 0=Hold 1=BuyWBTC 2=SellWBTC 3=BuyWETH 4=SellWETH 5=BuySOMI 6=SellSOMI.");
        return summary;
    }

    function vaultLine(
        string memory label,
        address pool,
        uint256 duelId,
        uint8   fighterId,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta
    ) internal view returns (string memory) {
        ArenaTypes.PoolBalance memory bal = fighterBalances[pool][duelId][fighterId];
        ArenaTypes.PoolMeta    memory meta = poolMeta[pool];
        uint256 baseUnit = 10 ** meta.baseDecimals;
        uint256 usdso     = bal.quoteTokenAmount / 1e18;
        uint256 baseWhole = bal.baseTokenAmount / baseUnit;
        uint256 baseFrac  = (bal.baseTokenAmount % baseUnit) * 10000 / baseUnit;
        uint256 markPrice = midMarkPrice(pool);
        string memory flag = (
            meta.minQuantity > 0 &&
            markPrice > 0 &&
            bal.quoteTokenAmount >= (meta.minQuantity * markPrice) / baseUnit
        ) ? "" : " [skip-no-funds]";
        return string.concat(
            label, ": ", uint256ToString(usdso), " USDso / ",
            uint256ToString(baseWhole), ".", uint256ToString(baseFrac), " base",
            flag, "."
        );
    }
}
