#!/usr/bin/env bash
# One scheduled fixture. Takes the market and the round count, so the same wrapper
# serves all three of the day's fights:
#
#   daily-duel-cron.sh events 9      06:02 IST / 00:32 UTC
#   daily-duel-cron.sh perps  6      12:02 IST / 06:32 UTC
#   daily-duel-cron.sh spot   3      18:02 IST / 12:32 UTC
#
# Called with no arguments it runs the original practice/3 fixture, so an old
# crontab line keeps working unchanged.
set -uo pipefail
export PATH=/usr/bin:/usr/local/bin:$PATH
cd /home/ubuntu/app/coliseum || exit 1

MARKET_NAME="${1:-practice}"
ROUNDS="${2:-3}"

case "$MARKET_NAME" in
  spot)     MARKET_ID=0 ;;
  practice) MARKET_ID=1 ;;
  events)   MARKET_ID=2 ;;
  perps)    MARKET_ID=3 ;;
  *) echo "unknown market '$MARKET_NAME' (spot|practice|events|perps)" >&2; exit 2 ;;
esac

# A log and a failure marker PER FIXTURE. Sharing one of each meant the last run of
# the day erased the earlier one's failure: a broken events fight at 06:02 looked
# fine by 18:03 because spot had since succeeded and cleared the marker.
LOG=/home/ubuntu/app/coliseum/logs/daily-duel-${MARKET_NAME}.log
MARK=/home/ubuntu/app/coliseum/logs/daily-duel-${MARKET_NAME}-FAILED

echo "[$(date -u +%FT%TZ)] === cron start ${MARKET_NAME} ${ROUNDS}r ===" >> "$LOG"

# ALWAYS bring the paused processes back, however this script ends.
#
# The restart used to sit on the line after the run, so anything that killed the
# script mid-fight — a timeout, an OOM, a manual Ctrl-C — left the watcher and the
# house bot stopped for good. Nothing rings the turns after that: the arena simply
# goes quiet, and the only clue is a fixture log nobody is reading. A trap makes the
# restart unconditional.
resume() {
  echo "[$(date -u +%FT%TZ)] resuming watcher + housematch" >> "$LOG"
  pm2 start coliseum-watcher coliseum-housematch >> "$LOG" 2>&1
}
trap resume EXIT

# The watcher shares the deployer key, so leaving it running would race this script
# for nonces. The house bot would grab the lonely slot before player 2 arrives, and
# the fixture would end up playing the house instead of itself.
pm2 stop coliseum-watcher coliseum-housematch >> "$LOG" 2>&1

DUEL_MARKET=$MARKET_ID DUEL_TURNS=$ROUNDS \
  pnpm exec hardhat run scripts/daily-duel.ts --network somnia >> "$LOG" 2>&1
RC=$?

echo "[$(date -u +%FT%TZ)] === cron end ${MARKET_NAME} rc=$RC ===" >> "$LOG"

# Fail loudly. Writing to stderr makes cron mail it, and the marker file is what to
# check when the arena looks quiet.
if [ "$RC" -ne 0 ]; then
  echo "[$(date -u +%FT%TZ)] daily-duel ${MARKET_NAME} ${ROUNDS}r FAILED rc=$RC — see $LOG" | tee "$MARK" >&2
  tail -n 20 "$LOG" >&2
else
  rm -f "$MARK"
fi

exit "$RC"
