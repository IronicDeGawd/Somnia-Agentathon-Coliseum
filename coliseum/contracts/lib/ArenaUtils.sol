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

    // ─── Qualitative language ─────────────────────────────────────────────────
    //
    // Every word in this section exists to keep DIGITS out of the fighter's
    // prompt. The inference agent extracts the FIRST integer it finds in the
    // model's reply and clamps it into the caller's range, and the model freely
    // echoes numbers back out of the prompt it was given. With actions labelled
    // 0..6, an echoed price of 0.803 was extracted as 803, clamped to 6, and
    // executed as SellSOMI by a fighter holding nothing — losing duel 21.
    //
    // The decision path now carries no digits at all: the market is described in
    // words, holdings are described in words, and the answer is a name chosen
    // from an allow-list rather than an index.

    /// @dev Turn counts are capped by the tier table at fifteen.
    function turnWord(uint16 n) internal pure returns (string memory) {
        if (n == 1)  return "one";
        if (n == 2)  return "two";
        if (n == 3)  return "three";
        if (n == 4)  return "four";
        if (n == 5)  return "five";
        if (n == 6)  return "six";
        if (n == 7)  return "seven";
        if (n == 8)  return "eight";
        if (n == 9)  return "nine";
        if (n == 10) return "ten";
        if (n == 11) return "eleven";
        if (n == 12) return "twelve";
        if (n == 13) return "thirteen";
        if (n == 14) return "fourteen";
        if (n == 15) return "fifteen";
        return "many";
    }

    /// @notice Describe a price move in words. Thresholds are the same basis-point
    ///         bands the prompt tournament was scored against (half a percent, one
    ///         and a half, three), so measured behaviour carries over unchanged.
    function moveWord(uint256 cur, uint256 prev) internal pure returns (string memory) {
        // Turn one has no prior snapshot, so there is genuinely no move to report.
        // Saying "flat" there would be a claim the contract cannot support.
        if (prev == 0 || cur == 0) return "has just opened, with no move to read yet";
        bool up = cur > prev;
        uint256 bps = up ? (cur - prev) * 10000 / prev : (prev - cur) * 10000 / prev;
        if (bps < 50)  return "is flat";
        if (bps < 150) return up ? "is up slightly" : "is down slightly";
        if (bps < 300) return up ? "is up" : "is down";
        return up ? "is up sharply" : "is down sharply";
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

    // ─── Executable action set ───────────────────────────────────────────────

    /// @notice Can this fighter currently fund a buy and/or a sell in this pool?
    ///         A sell needs at least one whole lot of the base token; a buy needs
    ///         enough quote to cover one lot at the mark. An empty book gives no
    ///         price to size against, so neither side is offerable.
    function tradability(
        address pool,
        uint256 duelId,
        uint8   fighterId,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta
    ) internal view returns (bool canBuy, bool canSell) {
        ArenaTypes.PoolBalance memory bal  = fighterBalances[pool][duelId][fighterId];
        ArenaTypes.PoolMeta    memory meta = poolMeta[pool];
        uint256 markPrice = midMarkPrice(pool);
        if (meta.minQuantity == 0 || markPrice == 0) return (false, false);
        uint256 minCost = (meta.minQuantity * markPrice) / (10 ** meta.baseDecimals);
        return (bal.quoteTokenAmount >= minCost, bal.baseTokenAmount >= meta.minQuantity);
    }

    /// @notice The actions this fighter can actually execute right now, given the
    ///         tier's pools AND its current holdings.
    ///
    ///         This is the single source of truth for legality. It builds the
    ///         allow-list sent to the model, and it is re-run when the answer comes
    ///         back to check the model stayed inside it. Offering "SellWETH" to a
    ///         fighter holding no WETH invites a move that can only fail, and no
    ///         amount of prompt wording reliably stops a model from taking an option
    ///         it was handed. Hold is always executable.
    function legalActions(
        uint256 duelId,
        uint8   fighterId,
        ArenaTypes.Duel storage duel,
        address poolWeth,
        address poolWbtc,
        address poolSomi,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta
    ) public view returns (uint8[] memory) {
        uint8[7] memory buf;
        uint256 n = 0;
        buf[n++] = uint8(ArenaTypes.FighterAction.Hold);

        address[3] memory pools = [poolWbtc, poolWeth, poolSomi];
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_SOMI];
        // Buy/sell action ids per pool, matching the FighterAction enum order.
        uint8[3]   memory buys  = [uint8(1), uint8(3), uint8(5)];

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            (bool canBuy, bool canSell) = tradability(pools[i], duelId, fighterId, fighterBalances, poolMeta);
            if (canBuy)  buf[n++] = buys[i];
            if (canSell) buf[n++] = buys[i] + 1;
        }

        uint8[] memory out = new uint8[](n);
        for (uint256 i = 0; i < n; i++) out[i] = buf[i];
        return out;
    }

    /// @notice The same set as names, for the agent's `allowedValues`. Naming the
    ///         actions rather than numbering them is what removes the last integer
    ///         from the decision path.
    function actionNames(uint8[] memory ids) internal pure returns (string[] memory) {
        string[] memory names = new string[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) names[i] = actionName(ids[i]);
        return names;
    }

    /// @notice Resolve the model's answer against the executable set.
    /// @return ok     true when the answer names an action the fighter can execute
    /// @return action the matching action id, or Hold when there is no match
    function matchAction(uint8[] memory legal, string memory answer)
        internal pure returns (bool ok, uint8 action)
    {
        bytes32 want = keccak256(bytes(trim(answer)));
        for (uint256 i = 0; i < legal.length; i++) {
            if (keccak256(bytes(actionName(legal[i]))) == want) return (true, legal[i]);
        }
        return (false, uint8(ArenaTypes.FighterAction.Hold));
    }

    /// @notice Strip surrounding whitespace and quotes. The allow-list should make
    ///         the answer exact, but a stray newline or quote mark must not be the
    ///         difference between a fighter trading and holding.
    function trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 start = 0;
        uint256 end   = b.length;
        while (start < end && _isTrimmable(b[start])) start++;
        while (end > start && _isTrimmable(b[end - 1])) end--;
        bytes memory out = new bytes(end - start);
        for (uint256 i = 0; i < out.length; i++) out[i] = b[start + i];
        return string(out);
    }

    function _isTrimmable(bytes1 c) private pure returns (bool) {
        return c == 0x20 || c == 0x0a || c == 0x0d || c == 0x09 || c == 0x22 || c == 0x27 || c == 0x2e;
    }

    /// @notice Decode an ABI-encoded string returned by `inferString`, without
    ///         reverting on anything unexpected. A malformed payload must degrade
    ///         to a coerced Hold, never revert the callback and strand the turn.
    function decodeStringResult(bytes memory raw) internal pure returns (bool ok, string memory out) {
        if (raw.length < 64) return (false, "");
        // Dynamic string encoding: 32-byte offset, 32-byte length, then the bytes.
        // Both header words must be small, so every high byte has to be zero.
        for (uint256 i = 0; i < 24; i++) if (raw[i] != 0) return (false, "");
        uint256 offset = 0;
        for (uint256 i = 24; i < 32; i++) offset = (offset << 8) | uint8(raw[i]);
        if (offset != 32) return (false, "");

        for (uint256 i = 32; i < 56; i++) if (raw[i] != 0) return (false, "");
        uint256 len = 0;
        for (uint256 i = 56; i < 64; i++) len = (len << 8) | uint8(raw[i]);
        // Action names are short; anything long is prose, not an answer.
        if (len == 0 || len > 64 || raw.length < 64 + len) return (false, "");

        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) b[i] = raw[64 + i];
        return (true, string(b));
    }

    // ─── LLM prompt builder ──────────────────────────────────────────────────

    /// @notice Build the fighter's turn prompt. Contains no digits: see the note on
    ///         the qualitative language helpers above for why.
    function buildMarketSummary(
        uint256 duelId,
        uint8   fighterId,
        ArenaTypes.Duel storage duel,
        address poolWeth,
        address poolWbtc,
        address poolSomi,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta,
        mapping(uint256 => mapping(address => uint256)) storage markSnapshots,
        mapping(uint256 => mapping(address => uint256)) storage prevMarkSnapshots
    ) public view returns (string memory) {
        uint16 turnNum = duel.completedCallbacks / 2 + 1;
        // lastAction is uint8[2], indexed by SLOT (0=fighterA, 1=fighterB) — NOT
        // the registry fighterId (0..5), which would overflow the size-2 array.
        uint8 lastSlot = fighterId == duel.fighterA ? 0 : 1;

        string memory summary = string.concat(
            "This is turn ", turnWord(turnNum), " of ", turnWord(duel.turns),
            ". Your last action was ", actionName(duel.lastAction[lastSlot]), "."
        );

        address[3] memory pools  = [poolWeth, poolWbtc, poolSomi];
        uint8[3]   memory bits   = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        string[3]  memory labels = ["WETH", "WBTC", "SOMI"];

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            summary = string.concat(summary, " ", holdingLine(
                labels[i], pools[i], duelId, fighterId,
                fighterBalances, poolMeta, markSnapshots, prevMarkSnapshots
            ));
        }

        string[] memory names = actionNames(legalActions(
            duelId, fighterId, duel, poolWeth, poolWbtc, poolSomi, fighterBalances, poolMeta
        ));
        summary = string.concat(summary, " Allowed actions: ", join(names), ".");
        return summary;
    }

    /// @notice One pool's state in words: how it moved, and whether the fighter
    ///         holds any of it. Position SIZE is deliberately absent — the allowed
    ///         action list already encodes what the fighter can afford, so a lots
    ///         figure would add a digit to the prompt while answering a question
    ///         nothing asks.
    function holdingLine(
        string memory label,
        address pool,
        uint256 duelId,
        uint8   fighterId,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta,
        mapping(uint256 => mapping(address => uint256)) storage markSnapshots,
        mapping(uint256 => mapping(address => uint256)) storage prevMarkSnapshots
    ) internal view returns (string memory) {
        ArenaTypes.PoolBalance memory bal  = fighterBalances[pool][duelId][fighterId];
        ArenaTypes.PoolMeta    memory meta = poolMeta[pool];

        uint256 cur = markSnapshots[duelId][pool];
        if (cur == 0) cur = midMarkPrice(pool);
        uint256 prev = prevMarkSnapshots[duelId][pool];

        bool holds = meta.minQuantity > 0 && bal.baseTokenAmount >= meta.minQuantity;
        return string.concat(
            label, " ", moveWord(cur, prev), ". You hold ", holds ? "some " : "no ", label, "."
        );
    }

    function join(string[] memory parts) internal pure returns (string memory out) {
        for (uint256 i = 0; i < parts.length; i++) {
            out = i == 0 ? parts[i] : string.concat(out, ", ", parts[i]);
        }
    }
}
