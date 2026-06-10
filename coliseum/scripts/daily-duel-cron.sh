#!/usr/bin/env bash
# Daily PvP duel keeper (simulated market). Pauses the watcher AND house-bot
# (watcher shares the deployer key → nonce safety; house-bot could otherwise
# grab the lonely slot before P2 queues), then resumes both.
set -uo pipefail
export PATH=/usr/bin:/usr/local/bin:$PATH
cd /home/ubuntu/app/coliseum || exit 1
LOG=/home/ubuntu/app/coliseum/logs/daily-duel-cron.log
echo "[$(date -u +%FT%TZ)] === cron start ===" >> "$LOG"
pm2 stop coliseum-watcher coliseum-housematch >> "$LOG" 2>&1
pnpm exec hardhat run scripts/daily-duel.ts --network somnia >> "$LOG" 2>&1
RC=$?
pm2 start coliseum-watcher coliseum-housematch >> "$LOG" 2>&1
echo "[$(date -u +%FT%TZ)] === cron end rc=$RC ===" >> "$LOG"
