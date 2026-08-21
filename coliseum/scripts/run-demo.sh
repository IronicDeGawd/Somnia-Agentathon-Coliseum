#!/usr/bin/env bash
# ============================================================================
# run-demo.sh — four fights, one per market, all live at once, then get out of
# the way.
#
# FOR TALKING OVER. It starts one fight on every market simultaneously, prints
# the URLs, and EXITS — the box's watcher drives the turns and finalizes, so
# nothing has to stay attached to a terminal while you present. Come back
# afterwards and claim.
#
#   bash scripts/run-demo.sh
#
# WHY EIGHT WALLETS. A wallet cannot be in two fights at once — transactions
# from one address are ordered, so one address in two fights collides on its own
# nonce. Four simultaneous fights therefore need eight.
#
# WHY SPOT RUNS NINE ROUNDS AND NOT SIX. There is no six-round spot tier in the
# lobby; it offers 9 and 15. (Three was removed on purpose — it activates a
# single coin market, so both fighters face the same one choice every turn and
# the fight converges to a tie.) Nine is the shortest spot on offer, and being
# the longest fight of the four it keeps something on screen after the others
# have settled.
#
# EVERY FIGHT USES A DIFFERENT PAIR OF FIGHTERS. The runner rotates through the
# roster from FIGHTER_OFFSET, so all six appear and no pairing repeats. Set
# FIGHTER_OFFSET to move the whole cast along between runs.
#
# Env:
#   BASE_URL         site under test (default the public site)
#   WALLET_FILE      JSON from make-test-wallets — needs EIGHT wallets
#   FIGHTER_OFFSET   where in the roster to start (default: rotates by duel id)
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

RPC=${RPC:-https://dream-rpc.somnia.network}
ARENA=0x301d9364bdb2fd76e33c13ebe8fcc956bacfbed6
USDSO=0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171
BASE_URL=${BASE_URL:-https://coliseum.somniaforge.com}
WALLET_FILE=${WALLET_FILE:?set WALLET_FILE — eight funded wallets}
LOG=${LOG:-/tmp/demo-run.log}
RESULTS=${RESULTS:-/tmp/demo-results.jsonl}

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

DEPLOYER_KEY=$(grep -E '^PRIVATE_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
waddr() { python3 -c "import json;print(json.load(open('$WALLET_FILE'))[$1]['address'])"; }

COUNT=$(python3 -c "import json;print(len(json.load(open('$WALLET_FILE'))))")
if [ "$COUNT" -lt 8 ]; then
  say "!! need EIGHT wallets for four simultaneous fights, found $COUNT"
  say "   COUNT=8 STT_EACH=2 USDSO_EACH=400 WALLET_FILE=$WALLET_FILE \\"
  say "     pnpm exec hardhat run scripts/make-test-wallets.ts --network somnia"
  exit 1
fi

# Spot at nine rounds costs ~113 USDso a side, so the check is worth doing before
# a demo rather than discovering it from a button that reads INSUFFICIENT.
say "checking the eight wallets can cover their fights"
for i in 0 1 2 3 4 5 6 7; do
  A=$(waddr $i)
  BAL=$(cast call "$USDSO" "balanceOf(address)(uint256)" "$A" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
  STT=$(cast balance "$A" --rpc-url "$RPC" 2>/dev/null)
  say "  wallet $i  $A  ${BAL:-?} wei USDso  ${STT:-?} wei STT"
done

MIN_DUEL=$(cast call "$ARENA" "nextDuelId()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
say "duels from $MIN_DUEL onward belong to this run"

# One batch, four entries, one per market — so all four are live together.
# Pair 0..3 maps to wallet pairs (0,1) (2,3) (4,5) (6,7).
BATCH='[{"market":"EVENTS","turns":6,"pair":0},{"market":"PERPS","turns":6,"pair":1},{"market":"PRACTICE","turns":6,"pair":2},{"market":"SPOT","turns":9,"pair":3}]'

say "starting four fights — events 6r, perps 6r, practice 6r, spot 9r"
: >"$RESULTS"
# Passed even when blank: the spec treats an empty FIGHTER_OFFSET as unset and falls
# back to MIN_DUEL. Deliberately NOT an array — this runs on macOS bash 3.2, where
# expanding an empty array under `set -u` is itself an unbound-variable error, which
# is how the first run of this script started no fights at all.
( cd e2e && env MATRIX="$BATCH" WALLET_FILE="$WALLET_FILE" RESULT_FILE="$RESULTS" \
    MIN_DUEL="$MIN_DUEL" BASE_URL="$BASE_URL" FIGHTER_OFFSET="${FIGHTER_OFFSET:-}" \
    npx playwright test tests/all-markets.spec.ts --workers=4 --reporter=list ) 2>&1 | tee -a "$LOG"
RC=$?

say "── what is now live ──"
python3 - "$RESULTS" "$BASE_URL" <<'PY' | tee -a "$LOG"
import json, sys
path, base = sys.argv[1], sys.argv[2]
rows = []
for line in open(path):
    line = line.strip()
    if line:
        rows.append(json.loads(line))
if not rows:
    print("  NOTHING STARTED — the fights did not begin, do not present this")
    raise SystemExit
for r in sorted(rows, key=lambda x: x["duelId"]):
    who = " vs ".join(r.get("fighters", ["?", "?"]))
    print(f'  {r["market"]:<9} {r["turns"]:>2}r  duel {r["duelId"]}  {who}')
    print(f'             {base}/duel/{r["duelId"]}')
print()
print(f'  the lobby, with all four on it:  {base}/duel')
PY

say "── leaving them to run ──"
say "The box's watcher drives every turn and finalizes each fight on its own, so"
say "nothing needs this terminal. A six-round fight takes roughly six minutes at"
say "one turn a minute, longer with four running at once, because a reactive"
say "firing advances one fight at a time."
say ""
say "Afterwards, claim the stakes back:"
say "  WALLET_FILE=$WALLET_FILE pnpm exec hardhat run scripts/claim-all.ts --network somnia"
exit "$RC"
