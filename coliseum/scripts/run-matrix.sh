#!/usr/bin/env bash
# ============================================================================
# run-matrix.sh — every tier the lobby offers, played end to end, unattended.
#
# Twelve fights in six batches of two — one per tier the lobby actually offers.
# There is no three-round SPOT tier and no fifteen-round PRACTICE tier; asking for
# either makes the lobby click time out. The batching is not arbitrary:
#
#   - A WALLET CANNOT BE IN TWO FIGHTS AT ONCE. Transactions from one address are
#     ordered, so a pair in two concurrent fights collides on its own nonce. Four
#     wallets therefore means two concurrent fights, which is also the concurrency
#     that has actually been exercised safely.
#   - TWO FIGHTS ON ONE TIER CROSS-PAIR. A tier is a single waiting line holding
#     one player, so four players in one line match in arrival order and which two
#     met is not something a test can assert. Every batch pairs two DIFFERENT
#     (market, turns) combinations.
#   - A REACTIVE FIRING TAKES ONE TURN. More concurrent fights means each advances
#     less often, so raising concurrency does not shorten the run by much and does
#     make each fight longer.
#
# Every fight is real: a real deposit, real orders, a real settled result.
#
#   bash scripts/run-matrix.sh
#
# Env:
#   BASE_URL     site under test (default the public site)
#   WALLET_FILE  the JSON written by make-test-wallets
#   LOG          where to append progress
# ============================================================================
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RPC=${RPC:-https://dream-rpc.somnia.network}
ARENA=0x301d9364bdb2fd76e33c13ebe8fcc956bacfbed6
MATCHMAKER=0x68835367edbc36b054e82c5fe20f45ff6c095801
USDSO=0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171
BASE_URL=${BASE_URL:-https://coliseum.somniaforge.com}
WALLET_FILE=${WALLET_FILE:?set WALLET_FILE}
LOG=${LOG:-/tmp/matrix-run.log}
RESULTS=${RESULTS:-/tmp/matrix-results.jsonl}

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

DEPLOYER_KEY=$(grep -E '^PRIVATE_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
wkey()  { python3 -c "import json;print(json.load(open('$WALLET_FILE'))[$1]['privateKey'])"; }
waddr() { python3 -c "import json;print(json.load(open('$WALLET_FILE'))[$1]['address'])"; }
keyfor() { python3 -c "
import json,sys
for w in json.load(open('$WALLET_FILE')):
    if w['address'].lower()=='$1'.lower(): print(w['privateKey']); break"; }

# ── Fund the wallets once ──────────────────────────────────────────────────
# USDso is mintable by anyone on this testnet, so a top-up costs nothing. STT is
# the gas token and is not mintable, so it comes from the deployer — and a queue
# transaction is given a 40,000,000 limit, which at 6 gwei reserves about a
# quarter of an STT even though it spends far less.
say "funding four wallets"
for i in 0 1 2 3; do
  A=$(waddr $i)
  cast send "$USDSO" "mint(address,uint256)" "$A" 1000000000000000000000 \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" --legacy >/dev/null 2>&1
  cast send "$A" --value 3000000000000000000 \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" --legacy >/dev/null 2>&1
  say "  $A  $(cast call "$USDSO" 'balanceOf(address)(uint256)' "$A" --rpc-url "$RPC" | cut -d' ' -f1) wei USDso, $(cast balance "$A" --rpc-url "$RPC") wei STT"
done

# ── The batches ────────────────────────────────────────────────────────────
# Override to run a subset — one shell-quoted JSON batch per line, newline
# separated. Used to re-confirm a single market after a prompt change without
# paying for all twelve fights:
#
#   BATCHES_OVERRIDE='[{"market":"PERPS","turns":3,"pair":0},{"market":"PERPS","turns":6,"pair":1}]
#   [{"market":"PERPS","turns":9,"pair":0},{"market":"PERPS","turns":15,"pair":1}]'
#
# Two fights on the SAME market are fine as long as the TIERS differ — a waiting
# line is keyed on (tier, market), so different tiers cannot cross-pair.
if [ -n "${BATCHES_OVERRIDE:-}" ]; then
  BATCHES=()
  while IFS= read -r line; do
    [ -n "$line" ] && BATCHES+=("$line")
  done <<< "$BATCHES_OVERRIDE"
else
BATCHES=(
  '[{"market":"EVENTS","turns":3,"pair":0},{"market":"PERPS","turns":3,"pair":1}]'
  '[{"market":"EVENTS","turns":6,"pair":0},{"market":"PERPS","turns":6,"pair":1}]'
  '[{"market":"EVENTS","turns":9,"pair":0},{"market":"PERPS","turns":9,"pair":1}]'
  '[{"market":"EVENTS","turns":15,"pair":0},{"market":"PERPS","turns":15,"pair":1}]'
  '[{"market":"SPOT","turns":9,"pair":0},{"market":"PRACTICE","turns":6,"pair":1}]'
  '[{"market":"SPOT","turns":15,"pair":0},{"market":"PRACTICE","turns":9,"pair":1}]'
)
fi

# Reads one field out of the duels() tuple. Solidity OMITS the uint8[2] array, so
# the tuple is 13 fields: 5=completedCallbacks, 6=turns, 8=status.
field() {
  cast call "$ARENA" "duels(uint256)" "$1" --rpc-url "$RPC" 2>/dev/null \
    | python3 -c "import sys;r=sys.stdin.read().strip()[2:];print(int(r[$2*64:($2+1)*64],16))"
}

ALL_DUELS=""

for n in "${!BATCHES[@]}"; do
  BATCH="${BATCHES[$n]}"
  MIN_DUEL=$(cast call "$ARENA" 'nextDuelId()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)
  say "── batch $((n+1))/${#BATCHES[@]}  $BATCH  (min duel $MIN_DUEL)"

  BATCH_RESULTS=$(mktemp)
  # FIGHTER_OFFSET is forwarded even when blank — the spec treats an empty value as
  # unset and falls back to the duel floor, which is what rotates the cast between
  # runs. Set it to pin an exact pairing, which is how a specific matchup gets
  # re-run after a change (offset 2 is Quant against Contrarian, the two most
  # patient personas and the pair that once held every turn).
  ( cd e2e && MATRIX="$BATCH" WALLET_FILE="$WALLET_FILE" RESULT_FILE="$BATCH_RESULTS" \
      BASE_URL="$BASE_URL" MIN_DUEL="$MIN_DUEL" FIGHTER_OFFSET="${FIGHTER_OFFSET:-}" \
      pnpm exec playwright test all-markets --workers=2 ) >>"$LOG" 2>&1
  RC=$?
  cat "$BATCH_RESULTS" >>"$RESULTS" 2>/dev/null

  IDS=$(python3 -c "
import json,sys
for line in open('$BATCH_RESULTS'):
    line=line.strip()
    if line: print(json.loads(line)['duelId'])" 2>/dev/null | tr '\n' ' ')
  say "  started: ${IDS:-none} (playwright rc=$RC)"
  [ -z "$IDS" ] && { say "  !! nothing started — moving on"; rm -f "$BATCH_RESULTS"; continue; }

  # ── Wait for the fights to run their course ──────────────────────────────
  # Turns are driven by Reactivity, which re-arms itself. Finalizing is NOT
  # automatic when the box's watcher is not running, so a fight can sit with every
  # callback done and still read active — that is what the finalize below is for.
  DEADLINE=$(( $(date +%s) + 2400 ))
  for id in $IDS; do
    while :; do
      ST=$(field "$id" 8); CB=$(field "$id" 5); TU=$(field "$id" 6)
      [ "$ST" = "3" ] && { say "  duel $id resolved"; break; }
      if [ -n "${CB:-}" ] && [ -n "${TU:-}" ] && [ "$CB" -ge $((TU*2)) ]; then
        say "  duel $id has run its $TU rounds — finalizing"
        cast send "$ARENA" "finalizeDuel(uint256)" "$id" --private-key "$DEPLOYER_KEY" \
          --rpc-url "$RPC" --legacy --gas-limit 12000000 >/dev/null 2>&1
      fi
      if [ "$(date +%s)" -gt "$DEADLINE" ]; then
        say "  !! duel $id still at status ${ST:-?} after 40 min — leaving it and moving on"
        break
      fi
      sleep 30
    done
  done

  # ── Claim, so nothing is left escrowed ───────────────────────────────────
  # An unclaimed payout blocks a future rewire, and the deposit stays locked out of
  # the next batch. Claimed per player, because that is who the payout belongs to.
  for id in $IDS; do
    PLAYERS=$(python3 -c "
import json
for line in open('$BATCH_RESULTS'):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d['duelId']==$id: print(' '.join(d['players']))" 2>/dev/null)
    for p in $PLAYERS; do
      K=$(keyfor "$p")
      [ -z "$K" ] && continue
      cast send "$MATCHMAKER" "claimWinnings(uint256)" "$id" --private-key "$K" \
        --rpc-url "$RPC" --legacy --gas-limit 3000000 >/dev/null 2>&1
    done
    say "  duel $id claimed"
  done

  ALL_DUELS="$ALL_DUELS$IDS"
  rm -f "$BATCH_RESULTS"
done

DUEL_LIST=$(echo "$ALL_DUELS" | tr ' ' '\n' | grep -v '^$' | paste -sd, -)
say "── all batches done. duels: $DUEL_LIST"
say "── escrow now: $(cast call "$ARENA" 'escrowedPot()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1) wei"
echo "$DUEL_LIST" > /tmp/matrix-duels.txt

say "── summary"
DUELS="$DUEL_LIST" pnpm exec hardhat run scripts/matrix-summary.ts --network somnia 2>&1 | tee -a "$LOG"
say "── markdown for the README"
DUELS="$DUEL_LIST" MD=1 pnpm exec hardhat run scripts/matrix-summary.ts --network somnia 2>&1 | tee -a "$LOG"
say "── MATRIX RUN COMPLETE"
