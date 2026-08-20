// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ArenaTypes.sol";
import "../interfaces/ISpotPool.sol";
import "../interfaces/IERC20Minimal.sol";
import "../interfaces/IPerps.sol";
import "../interfaces/IArena.sol";

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
    ///
    ///         Perps behaves like events and for the same reason: the slots cost
    ///         roughly comparable margin rather than wildly different face values,
    ///         so there is no expensive slot to ration, and narrowing to one slot
    ///         would leave both fighters facing the same single option every turn.
    function poolMaskFor(uint16 turns, ArenaTypes.MarketKind kind) internal pure returns (uint8) {
        if (kind == ArenaTypes.MarketKind.Perps) {
            if (!isValidTurnCount(turns)) revert ArenaTypes.InvalidTurnCount();
            return ArenaTypes.POOL_BIT_WETH | ArenaTypes.POOL_BIT_WBTC | ArenaTypes.POOL_BIT_SOMI;
        }
        if (kind == ArenaTypes.MarketKind.Events) {
            if (!isValidTurnCount(turns)) revert ArenaTypes.InvalidTurnCount();
            return ArenaTypes.POOL_BIT_WETH | ArenaTypes.POOL_BIT_WBTC | ArenaTypes.POOL_BIT_SOMI;
        }
        return poolMaskForTurns(turns);
    }

    function isValidTurnCount(uint16 turns) internal pure returns (bool) {
        return turns == 3 || turns == 6 || turns == 9 || turns == 15;
    }

    // ─── The perps budget ladder ─────────────────────────────────────────────
    //
    // On every other market the entry price is DERIVED: read the books, add up what
    // a smallest order costs on each active slot, multiply by the round count. That
    // is honest and it is also why a nine-round spot fight costs $95.64 and why the
    // number moves between the moment a lobby quotes it and the moment a player
    // pays.
    //
    // Perps inverts the arithmetic. The budget is FIXED and advertised, and the
    // question becomes which markets that budget can afford — answered at duel start
    // by the registry, against live margin factors. So this function reads no book
    // and cannot move.
    //
    // The rungs are not a design; they fall out of measured margin costs
    // (2026-08-19, initial margin for one smallest position): XRP $0.050,
    // ADA $0.175, SOL $0.385, BNB $0.603, ETH $0.958, BTC $12.054. Two dollars
    // carries five of the six markets, with Ethereum a tight two-position squeeze so
    // that choices cost something; eighteen unlocks Bitcoin at exactly one position.

    /// @notice Collateral ONE fighter is given on a perps fight, in 18-decimal USDso.
    function perpBudget(uint16 turns) internal pure returns (uint256) {
        if (turns == 3)  return 2e18;
        if (turns == 6)  return 6e18;
        if (turns == 9)  return 12e18;
        if (turns == 15) return 18e18;
        revert ArenaTypes.InvalidTurnCount();
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
        // A fixed, advertised entry price — doubled for the two fighters, matching
        // the convention that this function returns the COMBINED figure and
        // `initialUsdsoPerFighter` is half of it. Deliberately before any pool read,
        // because the whole point of the perps tier is that its price does not depend
        // on what the books happen to say when someone opens the lobby.
        if (kind == ArenaTypes.MarketKind.Perps) return perpBudget(turns) * 2;

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

    // ─── Numbers, for the perps market only ──────────────────────────────────
    //
    // WHY THE RULE ABOVE DOES NOT APPLY HERE. The digit ban was a fix for
    // `inferNumber`, which pulled the first integer out of the model's free text and
    // clamped it into an action index — so a price echoed back became a trade nobody
    // asked for. Perps asks with `inferString` against a fixed list of names, matched
    // exactly. A digit in the prompt cannot become an action any more: the worst a
    // numeric reply can do is match nothing, which is recorded as a coercion and
    // taken as Hold. Visible, and not silent.
    //
    // AND PERPS NEEDS THEM. A spot fighter can act on words alone, because "you hold
    // no WETH" is itself a reason to buy. A perps fighter is flat by default and its
    // whole decision is a direction and a size against a level — measured 2026-08-19,
    // two fights, eighteen moves, every one a Hold, because every market read as
    // "flat": the word bands call anything under fifty basis points flat and the
    // largest move in any turn was seven.

    /// @notice A whole number as its decimal digits.
    function uToStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) { len++; n /= 10; }
        bytes memory b = new bytes(len);
        n = v;
        while (n != 0) { b[--len] = bytes1(uint8(48 + n % 10)); n /= 10; }
        return string(b);
    }

    /// @notice A fixed-point value as a decimal string.
    /// @param  decimals the value's own scale (18 for USDso, 8 for a BTC size)
    /// @param  places   digits to keep after the point; the rest are dropped, not
    ///                  rounded, because a price that reads higher than it is would
    ///                  be worse than one that reads slightly low.
    function fixedStr(uint256 v, uint8 decimals, uint8 places) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        uint256 whole = v / unit;
        if (places == 0) return uToStr(whole);
        uint256 frac = ((v % unit) * (10 ** places)) / unit;
        // Zero-pad the fraction, or 1.05 prints as "1.5".
        bytes memory pad = new bytes(places);
        for (uint256 i = places; i > 0; i--) { pad[i - 1] = bytes1(uint8(48 + frac % 10)); frac /= 10; }
        return string.concat(uToStr(whole), ".", string(pad));
    }

    /// @notice A price in quote units, with more precision for small numbers than
    ///         large ones — four places on an XRP mark near one, two on a BTC mark in
    ///         the tens of thousands, where four would be noise.
    function priceStr(uint256 p) internal pure returns (string memory) {
        return fixedStr(p, 18, p < 10e18 ? 4 : 2);
    }

    /// @notice A signed fixed-point value, with its sign always written out. The plus
    ///         is deliberate: "up 0.04" and "0.04" read the same to a model skimming,
    ///         and the sign IS the information on a short position.
    function signedStr(int256 v, uint8 decimals, uint8 places) internal pure returns (string memory) {
        if (v < 0) return string.concat("-", fixedStr(uint256(-v), decimals, places));
        return string.concat("+", fixedStr(uint256(v), decimals, places));
    }

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

    /// @notice Per-slot labels, in slot order [WETH, WBTC, SOMI], plus which slots
    ///         are perp markets.
    ///
    ///         A label with `perp` false is a prediction question; with `perp` true
    ///         it is a market name ("ETH"). An empty label means the slot is an
    ///         ordinary spot pool and names its own asset.
    ///
    ///         `perp` is a third MODE rather than a different label, because the two
    ///         differences are not sayable in a label: a perps slot's actions are
    ///         directions rather than a purchase and a sale, and a fighter with
    ///         nothing may still take one of them.
    struct Vocab {
        bytes8[3] label;
        bool[3]   perp;
    }

    /// @notice Read the vocabulary off the pools a duel actually recorded, so it
    ///         cannot drift when the desks are later re-pointed at new questions.
    function vocabFor(
        address[3] memory pools,
        mapping(address => bytes8) storage poolLabel,
        mapping(address => bool) storage poolIsPerp
    ) internal view returns (Vocab memory v) {
        for (uint256 i = 0; i < 3; i++) {
            v.label[i] = poolLabel[pools[i]];
            v.perp[i]  = poolIsPerp[pools[i]];
        }
    }

    /// @dev Action ids pair up per slot: 1/2 WBTC, 3/4 WETH, 5/6 SOMI. The enum is
    ///      deliberately NOT extended for perps — the existing two ids per slot
    ///      become the two directions, so the odd id is Long where it used to be Buy
    ///      and the even id is Short where it used to be Sell. Closing a position is
    ///      taking the other side, which needs no third action.
    function actionName(uint8 a, Vocab memory v) internal pure returns (string memory) {
        if (a == 0 || a > 6) return "Hold";
        uint256 slot = a <= 2 ? 1 : (a <= 4 ? 0 : 2);
        bool buy = a % 2 == 1;
        if (v.perp[slot]) {
            string memory m = labelText(v.label[slot]);
            return buy ? string.concat("Long", m) : string.concat("Short", m);
        }
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
        address usdso,
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
        //
        // THE VAULT IS THE THIRD CONDITION, and leaving it out cost real turns. A
        // fighter's quote balance is a LEDGER entry — its share of the pot — while
        // the money an order actually draws on is the Arena's own deposit in this
        // pool, which is seeded separately and can run dry. The execution path
        // checks it and refuses; this one did not and offered anyway, so a fighter
        // was handed a buy that could never fill and lost its turn to it. That is
        // the same fault as offering a sell to a fighter holding nothing.
        //
        // Measured on duel 36: both fighters attempted a buy every single turn and
        // every one was refused, because the spot vaults held 0.09, 2.00 and 0.87
        // USDso against a minimum Bitcoin lot costing 64.59.
        // The SELL side needs the same treatment, and for a sharper reason: the two
        // numbers can disagree. Measured on duel 36, fighter 1's ledger recorded one
        // whole SOMI while the Arena's base holding at that pool was zero — so the
        // fighter was offered a sell every turn and the venue refused every one.
        // Whatever causes that gap, a fighter should not pay for it with its turn.
        return (
            bal.quoteTokenAmount >= minCost
                && canFundBuy(pool, usdso, minCost)
                && _hasSize(pool, false),
            bal.baseTokenAmount >= meta.minQuantity
                && _canDeliverBase(pool, meta.minQuantity)
                && _hasSize(pool, true)
        );
    }

    /// @notice Can this Arena pay for one smallest buy — from EITHER pot?
    ///
    ///         Deliberately not private: the turn path asks the SAME question again
    ///         before it places the order, and the two answers must come from one
    ///         piece of code. They did not, and that is how a widened offer gate
    ///         still produced "vault below min cost" on every buy — the gate had
    ///         learned about the second pot and the executor had not.
    ///
    ///      There are two, and the venue will take from both. What was DEPOSITED with
    ///      the pool is one; this contract's OWN balance is the other. Measured
    ///      2026-08-20: a buyer holding nothing at the venue, having granted only an
    ///      allowance, had its order filled and paid for straight out of its wallet
    ///      (tx 0x8441edb5…). So a buy the wallet can afford is a buy that works.
    ///
    ///      Asking only about the deposit is what made this a live fault rather than a
    ///      tidy one. The deposit only ever falls — a fill is delivered to this
    ///      contract's balance and a sale's proceeds land there too, and nothing walks
    ///      value back — so it drains to nothing while the wallet fills up, and then
    ///      every buy is refused with the money in plain sight. That happened: the
    ///      three deposits fell 515.80 -> 466.29 USDso across a single fifteen-round
    ///      fight, with 110 USDso sitting unused in this contract's own balance.
    ///
    ///      Counting both is therefore the fix AND what makes withdrawing the deposits
    ///      safe. A pool that cannot answer for its deposit is treated as holding
    ///      nothing there rather than as fatal, so an unreadable venue costs a fighter
    ///      one option instead of its turn.
    function canFundBuy(address pool, address token, uint256 need) internal view returns (bool) {
        uint256 deposited;
        try ISpotPool(pool).getWithdrawableBalance(address(this), token) returns (uint256 avail) {
            deposited = avail;
        } catch { /* unreadable venue: counts as nothing deposited, not as a failure */ }
        if (deposited >= need) return true;

        // Fall back to this contract's OWN balance — but only the part of it that is
        // the house's money. The same balance also holds every live fight's escrowed
        // stakes, because starting a duel pulls each player's deposit in here. Paying
        // for a fighter's shopping out of another player's stake is exactly what the
        // rest of this contract is built to prevent: withdrawing the owner's seed is
        // capped at what the owner put in, the token sweep refuses this very token,
        // and fees are payable only from the balance ABOVE the escrowed pots. This
        // uses that same rule so the buy path cannot be the one hole in the floor.
        //
        // The escrowed figure lives in the router's storage and this is a library, so
        // it is asked for rather than read. A router that will not answer is treated
        // as fully escrowed, which refuses the buy — the safe direction.
        uint256 held;
        try IERC20Minimal(token).balanceOf(address(this)) returns (uint256 bal) {
            held = bal;
        } catch { return false; }
        uint256 escrowed;
        try IArena(address(this)).escrowedPot() returns (uint256 e) {
            escrowed = e;
        } catch { return false; }
        return held > escrowed && held - escrowed >= need;
    }

    /// @notice The reserve of the chain's own coin this contract will never trade
    ///         away, because that balance is also what pays for the fighters'
    ///         thinking.
    ///
    ///         Measured: a round of a fight costs about 0.243 coin in inference, so a
    ///         fifteen-round fight burns roughly 3.6, and six fights can run at once.
    ///         Thirty leaves room for every one of them plus a wide margin.
    ///
    ///         Above this line the coin is inventory a fighter may sell. At or below
    ///         it, it is fuel and the sale is simply not offered — which is a lost
    ///         option for one fighter, against fighters that cannot think at all.
    uint256 internal constant FUEL_RESERVE = 30e18;

    /// @dev Can this Arena actually deliver one smallest sell?
    ///
    ///      Deliberately NOT the pool-side balance, which is always zero for the base
    ///      asset. A venue takes the quote for a buy out of what was deposited to it,
    ///      but it DELIVERS a fill to the Arena's own wallet — so the tokens a sell
    ///      has to hand over sit in this contract's ERC-20 balance, not in any vault.
    ///
    ///      A base asset with no code is the chain's own COIN, and selling that means
    ///      sending value with the order.
    ///
    ///      THAT USED TO BE REFUSED OUTRIGHT, and the reason was real: the only coin
    ///      this contract holds is the same coin that buys the fighters' reasoning, so
    ///      a busy trading day could quietly stop them deciding anything — and that
    ///      coupling had already deadlocked the keeper once. A fighter losing one
    ///      option was the cheaper failure.
    ///
    ///      What changed is that the coin now has an income. The fuel pot converts
    ///      entry fees into it and tops this contract up, so the balance is replenished
    ///      from revenue rather than by hand. The coupling is bounded instead of
    ///      open-ended, and a reserve is enough to keep the two uses apart: above the
    ///      line it is inventory, at or below it, it is fuel.
    ///
    ///      Verified on chain before this was opened up: a contract CAN sell this
    ///      market by sending coin with the order — one coin out, 0.0956 stablecoin
    ///      in, tx 0x3b803fcc…. So this is a policy change, not a new mechanism.
    ///
    ///      The base token is asked of the pool rather than stored, so a re-pointed pool
    ///      cannot leave this reading a stale token's balance.
    function _canDeliverBase(address pool, uint256 need) internal view returns (bool) {
        try ISpotPool(pool).getPoolParams() returns (
            address baseToken, address, uint256, uint256, uint256, uint256, uint256
        ) {
            if (baseToken == address(0)) return false;
            if (baseToken.code.length == 0) {
                // The chain's own coin. Only what sits ABOVE the fuel reserve is
                // sellable, so a fighter can never trade away the ability to think.
                uint256 coin = address(this).balance;
                if (coin <= FUEL_RESERVE) return false;
                return coin - FUEL_RESERVE >= need;
            }
            try IERC20Minimal(baseToken).balanceOf(address(this)) returns (uint256 held) {
                return held >= need;
            } catch { return false; }
        } catch { return false; }
    }

    /// @notice The same question for a perps slot, which cannot be answered from a
    ///         token balance because a position is signed and can be negative.
    ///
    ///         This one function is what makes shorting possible at all. The spot
    ///         rule is "you may sell what you hold"; the perps rule is "you may take
    ///         either direction you can post margin for, and you may always turn
    ///         back". A fighter holding nothing is therefore offered Short, and
    ///         taking it opens a negative position.
    ///
    ///         Asked of the desk rather than computed here, because the answer needs
    ///         the fighter's live margin health, its current position on that market,
    ///         and the market's effective margin factor — none of which Arena holds.
    ///         A desk that cannot answer offers nothing, which costs a fighter one
    ///         option rather than its turn.
    function perpTradability(address desk, uint256 duelId, uint8 fighterId)
        internal view returns (bool canLong, bool canShort)
    {
        try IPerpDesk(desk).fighterTradability(duelId, fighterId) returns (bool l, bool s) {
            return (l, s);
        } catch { return (false, false); }
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
        address usdso,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta,
        mapping(address => bool) storage poolIsPerp
    ) public view returns (uint8[] memory) {
        uint8[7] memory buf;
        uint256 n = 0;
        buf[n++] = uint8(ArenaTypes.FighterAction.Hold);

        address[3] memory pools = [poolWbtc, poolWeth, poolSomi];
        uint8[3]   memory bits  = [ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_SOMI];
        // Buy/sell action ids per pool, matching the FighterAction enum order. On a
        // perps slot the same two ids mean long and short.
        uint8[3]   memory buys  = [uint8(1), uint8(3), uint8(5)];

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            (bool canBuy, bool canSell) = poolIsPerp[pools[i]]
                ? perpTradability(pools[i], duelId, fighterId)
                : tradability(pools[i], duelId, fighterId, usdso, fighterBalances, poolMeta);
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

    /// @notice Build the fighter's turn prompt.
    ///
    ///         It carries numbers now, on every market except events. The old rule
    ///         against digits was a fix for an agent that extracted a numeral and
    ///         clamped it into an action id; moves are chosen by exact name against
    ///         the executable set today, so a digit cannot become a trade.
    function buildMarketSummary(
        uint256 duelId,
        uint8   fighterId,
        ArenaTypes.Duel storage duel,
        address poolWeth,
        address poolWbtc,
        address poolSomi,
        address usdso,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta,
        mapping(uint256 => mapping(address => uint256)) storage markSnapshots,
        mapping(uint256 => mapping(address => uint256)) storage prevMarkSnapshots,
        mapping(uint256 => mapping(address => uint256)) storage openMarkSnapshots,
        mapping(address => bytes8) storage poolLabel,
        mapping(address => bool) storage poolIsPerp
    ) public view returns (string memory) {
        uint16 turnNum = duel.completedCallbacks / 2 + 1;
        // lastAction is uint8[2], indexed by SLOT (0=fighterA, 1=fighterB) — NOT
        // the registry fighterId (0..5), which would overflow the size-2 array.
        uint8 lastSlot = fighterId == duel.fighterA ? 0 : 1;

        address[3] memory pools  = [poolWeth, poolWbtc, poolSomi];
        uint8[3]   memory bits   = [ArenaTypes.POOL_BIT_WETH, ArenaTypes.POOL_BIT_WBTC, ArenaTypes.POOL_BIT_SOMI];
        Vocab memory v = vocabFor(pools, poolLabel, poolIsPerp);

        string memory summary = string.concat(
            "This is turn ", turnWord(turnNum), " of ", turnWord(duel.turns),
            ". Your last action was ", actionName(duel.lastAction[lastSlot], v), "."
        );

        // On perps the fighter's own standing is a number and belongs in the prompt
        // once, not per slot: one account backs all three markets.
        if (v.perp[0]) {
            summary = string.concat(summary, perpFighterLine(
                pools[0], duelId, fighterId, perpBudget(duel.turns)
            ));
        }

        for (uint256 i = 0; i < 3; i++) {
            if (duel.poolMask & bits[i] == 0) continue;
            summary = string.concat(summary, " ", holdingLine(
                i, v.label[i], v.perp[i], pools[i], duelId, fighterId,
                fighterBalances, poolMeta, markSnapshots, prevMarkSnapshots, openMarkSnapshots
            ));
        }

        string[] memory names = actionNames(legalActions(
            duelId, fighterId, duel, poolWeth, poolWbtc, poolSomi, usdso,
            fighterBalances, poolMeta, poolIsPerp
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
    /// @param perp true when the slot is a perp market, whose position is a
    ///        DIRECTION rather than a holding — so it is described as being long,
    ///        short, or flat, and never as holding some or none of a thing.
    function holdingLine(
        uint256 slot,
        bytes8  label,
        bool    perp,
        address pool,
        uint256 duelId,
        uint8   fighterId,
        mapping(address => mapping(uint256 => mapping(uint8 => ArenaTypes.PoolBalance))) storage fighterBalances,
        mapping(address => ArenaTypes.PoolMeta) storage poolMeta,
        mapping(uint256 => mapping(address => uint256)) storage markSnapshots,
        mapping(uint256 => mapping(address => uint256)) storage prevMarkSnapshots,
        mapping(uint256 => mapping(address => uint256)) storage openMarkSnapshots
    ) internal view returns (string memory) {
        ArenaTypes.PoolBalance memory bal  = fighterBalances[pool][duelId][fighterId];
        ArenaTypes.PoolMeta    memory meta = poolMeta[pool];

        uint256 cur = markSnapshots[duelId][pool];
        if (cur == 0) cur = midMarkPrice(pool);
        uint256 prev = prevMarkSnapshots[duelId][pool];

        bool holds = meta.minQuantity > 0 && bal.baseTokenAmount >= meta.minQuantity;

        if (perp) {
            return perpLine(
                label, pool, duelId, fighterId, cur, prev,
                openMarkSnapshots[duelId][pool], meta.baseDecimals
            );
        }

        if (label != bytes8(0)) {
            return string.concat(
                labelText(label), " ", markWord(cur), " ", oddsMoveWord(cur, prev),
                ". You ", holds ? "hold this position." : "do not hold this position."
            );
        }

        string memory asset = slot == 0 ? "WETH" : (slot == 1 ? "WBTC" : "SOMI");
        return spotLine(asset, cur, prev, openMarkSnapshots[duelId][pool], bal, meta);
    }

    /// @notice One spot slot, in the numbers a trader actually decides on.
    ///
    ///         Replaces a line that described a real coin book in words alone. A
    ///         book moves a few basis points in a sixty-second turn, so every slot
    ///         read "flat" every turn and a fighter was never shown a reason to do
    ///         anything — measured across three tiers, six fighters placed four
    ///         orders in total, all of them the same one asset.
    ///
    ///         Three price points rather than a move figure, for the same reason the
    ///         perps line carries them: the raw levels let the model see both the
    ///         step since last turn and the trend since the fight opened, which is
    ///         the difference between noise and a thesis.
    ///
    ///         The cash line matters more here than on perps. A spot fighter buys
    ///         outright, so what it can afford is a hard limit on what it may do,
    ///         and nothing in the old prompt said what a lot cost or what was left
    ///         to spend.
    function spotLine(
        string memory asset,
        uint256 cur,
        uint256 prev,
        uint256 open,
        ArenaTypes.PoolBalance memory bal,
        ArenaTypes.PoolMeta    memory meta
    ) internal pure returns (string memory) {
        // A book with no two-sided liquidity has no mid, and quoting that as a price
        // of zero would be a lie the fighter can act on — an asset that appears to
        // cost nothing invites a buy that cannot fill. Say there is no price instead.
        string memory line;
        if (cur == 0) {
            line = string.concat(asset, " has no price on the book right now. ");
        } else {
            // Only prices that DIFFER are mentioned. Repeating one figure three times
            // reads as three separate readings, which suggests movement where there is
            // none — the opposite of what this line is for.
            line = string.concat(asset, " at ", priceStr(cur));
            if (prev > 0 && prev != cur) line = string.concat(line, ", was ", priceStr(prev), " last turn");
            if (open > 0 && open != cur && open != prev) {
                line = string.concat(line, ", ", priceStr(open), " when the fight opened");
            }
            line = string.concat(line, ". ");
        }

        if (meta.minQuantity > 0 && bal.baseTokenAmount >= meta.minQuantity) {
            // Valued at the current mark, because "you hold 0.4 WETH" says nothing
            // about whether that is most of the fighter's money or none of it.
            uint256 held = (bal.baseTokenAmount * cur) / (10 ** uint256(meta.baseDecimals));
            line = string.concat(
                line, "You hold ", fixedStr(bal.baseTokenAmount, meta.baseDecimals, 4),
                " ", asset, ", worth ", fixedStr(held, 18, 4), " USDso."
            );
        } else {
            line = string.concat(line, "You hold no ", asset, ".");
        }

        line = string.concat(line, " Cash ", fixedStr(bal.quoteTokenAmount, 18, 4), " USDso.");

        if (meta.minQuantity > 0 && cur > 0) {
            uint256 lot = (meta.minQuantity * cur) / (10 ** uint256(meta.baseDecimals));
            if (lot > 0) {
                line = string.concat(
                    line, " The smallest trade here is ",
                    fixedStr(meta.minQuantity, meta.baseDecimals, 4), " ", asset,
                    ", costing ", fixedStr(lot, 18, 4), " USDso."
                );
            }
        }
        return line;
    }

    /// @notice One perps slot, in the numbers a trader actually decides on: where the
    ///         market is, where it was, which way this fighter is facing, what that is
    ///         worth, and what another position would cost.
    ///
    ///         Three price points rather than a move figure. A derived unit is one more
    ///         thing to misread, and the raw levels let the model see both the step
    ///         since last turn and the trend since the fight opened — which is the
    ///         difference between noise and a thesis on a market that moves a few
    ///         basis points a minute.
    function perpLine(
        bytes8  label,
        address pool,
        uint256 duelId,
        uint8   fighterId,
        uint256 cur,
        uint256 prev,
        uint256 open,
        uint8   baseDecimals
    ) internal view returns (string memory) {
        (address market, address reg) = perpWiring(pool);
        (int128 size, uint128 entry) = perpPosition(reg, market, duelId, fighterId);

        // Only prices that DIFFER are mentioned. Repeating the same figure three
        // times reads as three separate readings, which would suggest a market is
        // moving when it is standing still — the opposite of the problem this line
        // exists to fix.
        string memory line = string.concat(labelText(label), " at ", priceStr(cur));
        if (prev > 0 && prev != cur) line = string.concat(line, ", was ", priceStr(prev), " last turn");
        if (open > 0 && open != cur && open != prev) {
            line = string.concat(line, ", ", priceStr(open), " when the fight opened");
        }
        line = string.concat(line, ". ");

        if (size == 0 || entry == 0) {
            line = string.concat(line, "You are flat here.");
        } else {
            // Signed on purpose: the same size and the same price move mean opposite
            // things to a long and a short, and the sign is the only thing that says
            // which.
            int256 pnl = (int256(size) * (int256(cur) - int256(uint256(entry))))
                / int256(10 ** uint256(baseDecimals));
            uint256 mag = size > 0 ? uint256(uint128(size)) : uint256(uint128(-size));
            line = string.concat(
                line,
                size > 0 ? "You are long " : "You are short ",
                fixedStr(mag, baseDecimals, 4), " from ", priceStr(entry),
                ", worth ", signedStr(pnl, 18, 4), " USDso unrealised."
            );
        }

        uint256 imPerLot = perpLotCost(reg, market);
        if (imPerLot > 0) {
            line = string.concat(line, " One position here costs ", fixedStr(imPerLot, 18, 4), " USDso of margin.");
        }
        return line;
    }

    /// @notice This fighter's score and how much room it has left, once per turn
    ///         rather than once per slot — the account is shared across all three.
    ///
    ///         The score IS the equity, so a fighter that can see it can tell whether
    ///         it is ahead of where it started. Without this the only numbers in the
    ///         prompt would be about the markets and none about the fighter.
    function perpFighterLine(
        address pool,
        uint256 duelId,
        uint8   fighterId,
        uint256 budget
    ) internal view returns (string memory) {
        (, address reg) = perpWiring(pool);
        if (reg == address(0)) return "";

        address account;
        try IPerpRegistry(reg).accountOf(duelId, fighterId) returns (address a) { account = a; } catch {}
        if (account == address(0)) return "";

        string memory line = "";
        try IPerpRegistry(reg).equityOf(duelId, fighterId) returns (bool ok, int256 equity) {
            if (ok) {
                line = string.concat(
                    " Your score is ", equity > 0 ? fixedStr(uint256(equity), 18, 4) : "0",
                    " USDso, from ", fixedStr(budget, 18, 2), " at the start."
                );
            }
        } catch {}

        try IPerpRegistryPrompt(reg).freeMarginOf(account) returns (uint256 free) {
            line = string.concat(line, " Spare margin ", fixedStr(free, 18, 4), " USDso.");
        } catch {}
        return line;
    }

    /// @dev A desk names its own market and registry, and the registry names the bank.
    ///      Read rather than stored, because all three are immutable on the contracts
    ///      that hold them — so there is nothing here that can drift out of date.
    function perpWiring(address pool) internal view returns (address market, address reg) {
        try IPerpDesk(pool).market() returns (address m) { market = m; } catch {}
        try IPerpDesk(pool).registry() returns (address r) { reg = r; } catch {}
    }

    function perpPosition(address reg, address market, uint256 duelId, uint8 fighterId)
        internal view returns (int128 size, uint128 entry)
    {
        if (reg == address(0) || market == address(0)) return (0, 0);
        address account;
        try IPerpRegistry(reg).accountOf(duelId, fighterId) returns (address a) { account = a; } catch {}
        if (account == address(0)) return (0, 0);
        address bank;
        try IPerpRegistryPrompt(reg).bank() returns (address b) { bank = b; } catch {}
        if (bank == address(0)) return (0, 0);
        try IMarginBank(bank).getPosition(account, market) returns (int128 sz, uint128 e, int256, uint64) {
            return (sz, e);
        } catch { return (0, 0); }
    }

    function perpLotCost(address reg, address market) internal view returns (uint256) {
        if (reg == address(0) || market == address(0)) return 0;
        try IPerpRegistryPrompt(reg).marketCost(market) returns (bool ok, uint256 im) {
            return ok ? im : 0;
        } catch { return 0; }
    }

    function join(string[] memory parts) internal pure returns (string memory out) {
        for (uint256 i = 0; i < parts.length; i++) {
            out = i == 0 ? parts[i] : string.concat(out, ", ", parts[i]);
        }
    }
}
