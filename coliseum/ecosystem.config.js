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
 *   # boot both apps (dev)
 *   pm2 start ecosystem.config.js
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

const isProd = process.env.NODE_ENV === "production";

module.exports = {
  apps: [
    {
      name: "coliseum-frontend",
      cwd: "./frontend",
      script: "pnpm",
      args: isProd ? "start:prod" : "dev",
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
      cwd: "./",
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
  ],
};
