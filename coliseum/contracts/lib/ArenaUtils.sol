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

    /// @notice Which slots a fight trades, given its length AND its market.
    ///
    ///         The ladder above widens with the round count because it was built
    ///         for the coin books, where the slots cost wildly different amounts —
    ///         a smallest SOMI order is about nine cents, a smallest BTC order a
    ///         few dollars — so a short cheap fight used only the cheap slot.
    ///
    ///         On the events market that reasoning inverts: every slot holds a
    ///         prediction question costing a fraction of a cent, so there is no
    ///         expensive slot to ration. Narrowing there would only take choices
    ///         away — and a fight with ONE tradable slot has both fighters facing
    ///         the same single option every turn, which is how a fight ends in a
    ///         tie with nothing to watch.
    ///
    ///         So on events, every tier trades every slot and the tiers differ only
    ///         in how long the fight runs.
    function poolMaskFor(uint16 turns, ArenaTypes.MarketKind kind) internal pure returns (uint8) {
        if (kind == ArenaTypes.MarketKind.Events) {
            if (!isValidTurnCount(turns)) revert ArenaTypes.InvalidTurnCount();
            return ArenaTypes.POOL_BIT_WETH | ArenaTypes.POOL_BIT_WBTC | ArenaTypes.POOL_BIT_SOMI;
        }
        return poolMaskForTurns(turns);
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
        return minDepositFor(turns, ArenaTypes.MarketKind.Spot, poolWeth, poolWbtc, poolSomi, poolMeta);
    }

    /// @notice The same, for a stated market — which decides how many slots the
    ///         fight trades and therefore what it costs to cover them.
    function minDepositFor(
        uint16 turns,
        ArenaTypes.MarketKind kind,
        address poolWeth,
        address poolWbtc,
        address poolSomi,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta
    ) internal view returns (uint256 total) {
        uint8 mask = poolMaskFor(turns, kind);
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

    /// @notice Describe where a prediction is priced, in words. The mark of a
    ///         binary contract is its probability — a number between zero and one —
    ///         so calling it a price and reporting a percentage move would be two
    ///         different lies to the fighter.
    function markWord(uint256 mark) internal pure returns (string memory) {
        if (mark == 0)        return "has no reading yet";
        if (mark < 0.15e18)   return "is priced as very unlikely";
        if (mark < 0.35e18)   return "is priced as unlikely";
        if (mark < 0.45e18)   return "is leaning no";
        if (mark < 0.55e18)   return "is about even";
        if (mark < 0.65e18)   return "is leaning yes";
        if (mark < 0.85e18)   return "is priced as likely";
        return "is priced as very likely";
    }

    /// @notice The same basis-point bands as `moveWord`, said as odds shifting
    ///         rather than a price rising.
    function oddsMoveWord(uint256 cur, uint256 prev) internal pure returns (string memory) {
        if (prev == 0 || cur == 0) return "with no earlier reading to compare";
        bool toYes = cur > prev;
        uint256 bps = toYes ? (cur - prev) * 10000 / prev : (prev - cur) * 10000 / prev;
        if (bps < 50)  return "and the odds have barely moved";
        if (bps < 150) return toYes ? "and the odds have edged toward yes" : "and the odds have edged toward no";
        if (bps < 300) return toYes ? "and the odds have moved toward yes" : "and the odds have moved toward no";
        return toYes ? "and the odds have swung sharply toward yes" : "and the odds have swung sharply toward no";
    }

    // ─── Action vocabulary ───────────────────────────────────────────────────
    //
    // An event slot is not an asset, so "BuyWETH" would tell a fighter to buy a
    // coin when the slot actually holds a question about one. The names therefore
    // depend on what each slot currently is.
    //
    // CRITICAL: the allow-list sent to the model and the matcher that reads its
    // reply must be built from the SAME vocabulary. If they disagree, every answer
    // falls outside the set and every event trade becomes a silent Hold — which is
    // indistinguishable from a fighter that simply chose not to trade.

    /// @notice Per-slot question labels, in slot order [WETH, WBTC, SOMI].
    ///         An empty entry means that slot is an ordinary spot pool.
    struct Vocab {
        bytes8[3] label;
    }

    /// @notice Read the vocabulary off the pools a duel actually recorded, so it
    ///         cannot drift when the desks are later re-pointed at new questions.
    function vocabFor(
        address[3] memory pools,
        mapping(address => bytes8) storage poolLabel
    ) internal view returns (Vocab memory v) {
        for (uint256 i = 0; i < 3; i++) v.label[i] = poolLabel[pools[i]];
    }

    /// @dev Action ids pair up per slot: 1/2 WBTC, 3/4 WETH, 5/6 SOMI.
    function actionName(uint8 a, Vocab memory v) internal pure returns (string memory) {
        if (a == 0 || a > 6) return "Hold";
        uint256 slot = a <= 2 ? 1 : (a <= 4 ? 0 : 2);
        bool buy = a % 2 == 1;
        if (v.label[slot] != bytes8(0)) {
            string memory q = labelText(v.label[slot]);
            return buy ? string.concat("Back", q) : string.concat("Drop", q);
        }
        string memory asset = slot == 0 ? "WETH" : (slot == 1 ? "WBTC" : "SOMI");
        return buy ? string.concat("Buy", asset) : string.concat("Sell", asset);
    }

    /// @notice The characters of a label, up to the first empty one.
    function labelText(bytes8 label) internal pure returns (string memory) {
        uint256 n = 0;
        while (n < 8 && label[n] != 0) n++;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = label[i];
        return string(out);
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

        // Affording a trade is not the same as there being one to make. A
        // prediction question that has SETTLED still quotes a price — the answer
        // is now known — but accepts no orders, and a spot book can empty out.
        // Offering either got a fighter's order reverted and its turn lost, so
        // each side must have real size behind it before it is offered.
        return (
            bal.quoteTokenAmount >= minCost && _hasSize(pool, false),
            bal.baseTokenAmount >= meta.minQuantity && _hasSize(pool, true)
        );
    }

    /// @dev Is anyone actually resting an order on this side right now?
    ///      A buy needs someone selling, a sell needs someone buying.
    function _hasSize(address pool, bool isBid) private view returns (bool) {
        try ISpotPool(pool).getBookLevels(isBid, 1) returns (OrderBookLevel[] memory lv) {
            return lv.length > 0 && lv[0].quantity > 0;
        } catch { return false; }
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
    function actionNames(uint8[] memory ids, Vocab memory v) internal pure returns (string[] memory) {
        string[] memory names = new string[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) names[i] = actionName(ids[i], v);
        return names;
    }

    /// @notice Resolve the model's answer against the executable set.
    /// @return ok     true when the answer names an action the fighter can execute
    /// @return action the matching action id, or Hold when there is no match
    function matchAction(uint8[] memory legal, string memory answer, Vocab memory v)
        internal pure returns (bool ok, uint8 action)
    {
        bytes32 want = keccak256(bytes(trim(answer)));
        for (uint256 i = 0; i < legal.length; i++) {
            if (keccak256(bytes(actionName(legal[i], v))) == want) return (true, legal[i]);
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
        mapping(uint256 => mapping(address => uint256)) storage prevMarkSnapshots,
        mapping(address => bytes8) storage poolLabel
    ) public view returns (string memory) {
        uint16 turnNum = duel.completedCallbacks / 2 + 1;
        // lastAction is uint8[2], indexed by SLOT (0=fighterA, 1=fighterB) — NOT
        // the registry fighterId (0..5), which would overflow the size-2 array.
        uint8 lastSlot = fighterId == duel.fighterA ? 0 : 1;

        address[3] memory pools  = [poolWeth, poolWbtc, poolSomi];
        uint8[3]   memory bits   = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        Vocab memory v = vocabFor(pools, poolLabel);

        string memory summary = string.concat(
            "This is turn ", turnWord(turnNum), " of ", turnWord(duel.turns),
            ". Your last action was ", actionName(duel.lastAction[lastSlot], v), "."
        );

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            summary = string.concat(summary, " ", holdingLine(
                i, v.label[i], pools[i], duelId, fighterId,
                fighterBalances, poolMeta, markSnapshots, prevMarkSnapshots
            ));
        }

        string[] memory names = actionNames(legalActions(
            duelId, fighterId, duel, poolWeth, poolWbtc, poolSomi, fighterBalances, poolMeta
        ), v);
        summary = string.concat(summary, " Allowed actions: ", join(names), ".");
        return summary;
    }

    /// @notice One slot's state in words: how it moved, and whether the fighter
    ///         holds any of it. Position SIZE is deliberately absent — the allowed
    ///         action list already encodes what the fighter can afford, so a lots
    ///         figure would add a digit to the prompt while answering a question
    ///         nothing asks.
    ///
    ///         An event slot is described as a question whose odds have shifted; a
    ///         spot slot as an asset whose price has moved. Reporting a probability
    ///         as a price is how a fighter comes to read a market backwards.
    /// @param slot 0 WETH, 1 WBTC, 2 SOMI — names the asset when the slot is spot.
    /// @param label the slot's question, or empty when it holds a plain asset.
    function holdingLine(
        uint256 slot,
        bytes8  label,
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

        if (label != bytes8(0)) {
            return string.concat(
                labelText(label), " ", markWord(cur), " ", oddsMoveWord(cur, prev),
                ". You ", holds ? "hold this position." : "do not hold this position."
            );
        }

        string memory asset = slot == 0 ? "WETH" : (slot == 1 ? "WBTC" : "SOMI");
        return string.concat(
            asset, " ", moveWord(cur, prev), ". You hold ", holds ? "some " : "no ", asset, "."
        );
    }

    function join(string[] memory parts) internal pure returns (string memory out) {
        for (uint256 i = 0; i < parts.length; i++) {
            out = i == 0 ? parts[i] : string.concat(out, ", ", parts[i]);
        }
    }
}
