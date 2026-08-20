#!/usr/bin/env bash
# ============================================================================
# run-pair.sh — run ONE batch of two fights, wait them out, claim, summarise.
#
# The same machinery as run-matrix.sh, with the batch supplied instead of
# hardcoded, for when a single pair is the experiment rather than the whole
# ladder. Wallets are NOT funded here — run make-test-wallets first.
#
#   MATRIX='[{"market":"SPOT","turns":15,"pair":0},{"market":"PERPS","turns":15,"pair":1}]' \
#   WALLET_FILE=... bash scripts/run-pair.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

RPC=${RPC:-https://dream-rpc.somnia.network}
ARENA=0x301d9364bdb2fd76e33c13ebe8fcc956bacfbed6
MATCHMAKER=0x68835367edbc36b054e82c5fe20f45ff6c095801
BASE_URL=${BASE_URL:-https://coliseum.somniaforge.com}
WALLET_FILE=${WALLET_FILE:?set WALLET_FILE}
MATRIX=${MATRIX:?set MATRIX}
LOG=${LOG:-/tmp/pair-run.log}
RESULTS=${RESULTS:-/tmp/pair-results.jsonl}

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
DEPLOYER_KEY=$(grep -E '^PRIVATE_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
keyfor() { python3 -c "
import json
for w in json.load(open('$WALLET_FILE')):
    if w['address'].lower()=='$1'.lower(): print(w['privateKey']); break"; }
field() {
  cast call "$ARENA" "duels(uint256)" "$1" --rpc-url "$RPC" 2>/dev/null \
    | python3 -c "import sys;r=sys.stdin.read().strip()[2:];print(int(r[$2*64:($2+1)*64],16))"
}

MIN_DUEL=$(cast call "$ARENA" 'nextDuelId()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)
say "── $MATRIX  (min duel $MIN_DUEL)"

BR=$(mktemp)
( cd e2e && MATRIX="$MATRIX" WALLET_FILE="$WALLET_FILE" RESULT_FILE="$BR" \
    BASE_URL="$BASE_URL" MIN_DUEL="$MIN_DUEL" \
    pnpm exec playwright test all-markets --workers=2 ) >>"$LOG" 2>&1
say "  playwright rc=$?"
cat "$BR" >>"$RESULTS" 2>/dev/null

IDS=$(python3 -c "
import json
for line in open('$BR'):
    line=line.strip()
    if line: print(json.loads(line)['duelId'])" 2>/dev/null | tr '\n' ' ')
say "  started: ${IDS:-none}"
[ -z "$IDS" ] && { say "  !! nothing started"; exit 1; }
echo "$IDS" > /tmp/pair-duels-live.txt

DEADLINE=$(( $(date +%s) + 3600 ))
for id in $IDS; do
  while :; do
    ST=$(field "$id" 8); CB=$(field "$id" 5); TU=$(field "$id" 6)
    [ "$ST" = "3" ] && { say "  duel $id resolved"; break; }
    if [ -n "${CB:-}" ] && [ -n "${TU:-}" ] && [ "$CB" -ge $((TU*2)) ]; then
      say "  duel $id has run its $TU rounds — finalizing"
      cast send "$ARENA" "finalizeDuel(uint256)" "$id" --private-key "$DEPLOYER_KEY" \
        --rpc-url "$RPC" --legacy --gas-limit 12000000 >/dev/null 2>&1
    fi
    [ "$(date +%s)" -gt "$DEADLINE" ] && { say "  !! duel $id still status ${ST:-?} after 60 min"; break; }
    sleep 30
  done
done

for id in $IDS; do
  PLAYERS=$(python3 -c "
import json
for line in open('$BR'):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d['duelId']==$id: print(' '.join(d['players']))" 2>/dev/null)
  for p in $PLAYERS; do
    K=$(keyfor "$p"); [ -z "$K" ] && continue
    cast send "$MATCHMAKER" "claimWinnings(uint256)" "$id" --private-key "$K" \
      --rpc-url "$RPC" --legacy --gas-limit 3000000 >/dev/null 2>&1
  done
  say "  duel $id claimed"
done
rm -f "$BR"

DUEL_LIST=$(echo "$IDS" | tr ' ' '\n' | grep -v '^$' | paste -sd, -)
echo "$DUEL_LIST" > /tmp/pair-duels.txt
say "── done. duels: $DUEL_LIST"
say "── escrow now: $(cast call "$ARENA" 'escrowedPot()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1) wei"
DUELS="$DUEL_LIST" pnpm exec hardhat run scripts/matrix-summary.ts --network somnia 2>&1 | tee -a "$LOG"
say "── PAIR RUN COMPLETE"
