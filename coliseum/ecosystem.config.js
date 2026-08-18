/**
 * PM2 ecosystem for Coliseum.
 * Runs the Next.js frontend and the SwapFallback watcher bot together
 * under one process manager — independent restart policies, separate logs,
 * one start command.
 *
 * Quick start:
 *   # one-time, on the server
 *   npm i -g pm2
 *   pnpm install                       # installs deps for both workspaces
 *   cd frontend && pnpm build && cd .. # build Next once for prod start
 *
 *   # boot both apps (dev). Safe from any directory — cwd is absolute below.
 *   pm2 start /path/to/coliseum/ecosystem.config.js
 *
 *   # prod: serves `next start` instead of `next dev`
 *   NODE_ENV=production pm2 start ecosystem.config.js
 *
 *   # ops
 *   pm2 status
 *   pm2 logs                   # tail both
 *   pm2 logs coliseum-watcher  # tail just the watcher
 *   pm2 reload all             # zero-downtime reload after a deploy
 *   pm2 save && pm2 startup    # persist across reboot (run the printed cmd)
 *
 *   # individual control
 *   pm2 stop coliseum-frontend
 *   pm2 restart coliseum-watcher
 *
 * Env loading:
 *   - coliseum/.env  -> watcher (hardhat.config.ts uses `import 'dotenv/config'`)
 *   - coliseum/frontend/.env.local -> Next (loaded natively by next)
 * No secrets are duplicated into this file.
 */

const path = require("path");

// Absolute, derived from this file's own location. PM2 resolves a relative
// `cwd` against wherever `pm2 start` was invoked, so "./" silently pointed
// hardhat somewhere without a .env whenever the operator started from
// anywhere but coliseum/ — the bots then ran without their keys.
const ROOT = __dirname;
const FRONTEND = path.join(ROOT, "frontend");

module.exports = {
  apps: [
    {
      name: "coliseum-frontend",
      cwd: FRONTEND,
      script: "pnpm",
      args: "start:prod",
      env: {
        NODE_ENV: "production",
      },
      // Next dev/start handles its own watchers; PM2 just supervises.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 5000,
      out_file: "./logs/frontend.out.log",
      error_file: "./logs/frontend.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "coliseum-watcher",
      cwd: ROOT,
      script: "pnpm",
      args: "exec hardhat run scripts/watcher-bot.ts --network somnia",
      // hardhat.config.ts loads coliseum/.env automatically (dotenv/config).
      // SEEDER_ADDRESS, WATCHER_INTERVAL_S, SWEEP_THRESHOLD_STT, etc. come
      // from there. Override per-environment only if you need to.
      autorestart: true,
      // The watcher's main loop is supposed to run forever; restart if it
      // crashes, but back off so a persistent RPC failure doesn't hammer.
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: "60s",
      kill_timeout: 10000,
      out_file: "./logs/watcher.out.log",
      error_file: "./logs/watcher.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "coliseum-seeder",
      cwd: ROOT,
      script: "pnpm",
      args: "exec hardhat run scripts/seeder-bot.ts --network somnia",
      // Runs as SEEDER_PRIVATE_KEY (from coliseum/.env). Posts a resting BID
      // into the SOMI/USDso pool so user STT→USDso sells have a counterparty.
      // Fixed USDso budget, bootstrapped once (manifest flag), then idles when
      // spent. Tuning: SEEDER_USDSO_BUDGET, SEEDER_SPREAD_TICKS, SEEDER_INTERVAL_S.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: "60s",
      kill_timeout: 15000,
      out_file: "./logs/seeder.out.log",
      error_file: "./logs/seeder.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "coliseum-sim-market",
      cwd: ROOT,
      script: "pnpm",
      args: "exec hardhat run scripts/sim-market.ts --network somnia",
      // Drives the three MockSpotPool contracts for simulated duels. Updates
      // mark prices and bid/ask book levels every ~5 seconds via a random walk
      // so fighter trades fill at realistic, moving prices.
      // Requires sim pools to have been deployed first (SIM_MARKET=1 deploy).
      // Tuning: SIM_TICK_MS (tick interval in ms, default 5000).
      // Uses PRIVATE_KEY (deployer/owner) from coliseum/.env.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: "60s",
      kill_timeout: 10000,
      out_file: "./logs/sim-market.out.log",
      error_file: "./logs/sim-market.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "coliseum-housematch",
      cwd: ROOT,
      script: "pnpm",
      args: "exec hardhat run scripts/house-match-bot.ts --network somnia",
      // Fallback "house" opponent: when a player is waiting alone in the
      // Matchmaker queue, fills the opposing slot so the duel starts. Runs on
      // HOUSE_PRIVATE_KEY (from coliseum/.env) — its own wallet, so it never
      // contends with the deployer-key watcher for nonces. Covers tier 3 + 6
      // (real tiers 9/15 cost 91/151 USDso/side — beyond a demo bankroll, so
      // they're skipped). Tuning: HOUSE_MARKETS, HOUSE_TIERS, HOUSE_GRACE_S.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: "60s",
      kill_timeout: 10000,
      out_file: "./logs/housematch.out.log",
      error_file: "./logs/housematch.err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "coliseum-binder",
      cwd: ROOT,
      script: "pnpm",
      args: "exec hardhat run scripts/bind-event-window.ts --network somnia",
      // Re-points the prediction desks at fresh questions.
      //
      // A question is only alive for its window — an hour, or four. When the
      // last one expires the watcher hands the desks back, but nothing rebinds
      // them, so the events market keeps its lobby cards while no fight on it
      // can trade a single move. That is exactly what happened overnight: the
      // default, cheapest, most advertised market sat dead for ten hours.
      //
      // Runs every fifteen minutes and exits. It only touches IDLE desks, so it
      // cannot re-point a desk under a fight in progress, and it skips windows
      // with under MIN_LIFE_SEC left so a fight cannot outlive its own question.
      autorestart: false,
      cron_restart: "*/15 * * * *",
      kill_timeout: 120000,
      out_file: "./logs/binder.out.log",
      error_file: "./logs/binder.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
