# What runs on its own, how to deploy it, and where it lives

Six processes and two scheduled fights on one box, the deploy procedure for each piece, and the
live addresses. Every gotcha here is a real outage or a wasted hour.

## What runs on its own

Six processes and two scheduled fights, all on one box. Nothing here needs a person.

| runs | what it does |
|---|---|
| continuously | the **watcher** rings each turn, finalizes, settles bets and tends the desks |
| continuously | the **house bot** fills an empty waiting line so a lone player is never stuck |
| continuously | the **seeder** and **simulated market maker** keep the practice books alive |
| every 15 min | the **question binder** re-points the prediction desks at fresh questions |
| 2× daily | a **fixture**: one real PvP fight, on a different market each time |

The fixtures, in UTC — the box runs UTC:

| IST | UTC | market | rounds | |
|---|---|---|---|---|
| 06:02 | 00:32 | events | 9 | |
| 12:02 | 06:32 | perps | 6 | |
| 18:02 | 12:32 | spot | 3 | **paused** |

**Spot is parked, not deleted.** At three rounds the market narrows to SOMI alone, so both fighters
face a single option every turn — duel 90 had them buy SOMI at the same price in the same block, and
one sold it back. There is nothing to watch in that, so it does not earn a daily slot at this tier.
The crontab keeps the line commented with a nine-round version beside it: that buys a real
three-asset fight for about 113 USDso a side, which is the version worth running if the slot is
wanted back.

**Why :32 and not the hour.** The binder runs at :00, :15, :30 and :45. An events fixture starting
in the same second as a binder pass is a race on the market most likely to be watched — and two
minutes of drift also puts the events fight just *after* a fresh bind, which is the best moment for
it rather than merely a safe one.

**Each fixture pauses the watcher and the house bot for its duration** — the watcher because it
shares the deployer key and would race the fixture for nonces, the house bot because it would take
the lonely slot before the second player arrived. They are resumed from a shell trap, so a run killed
mid-fight cannot leave the arena with nobody ringing turns. That was a real hole: the resume used to
sit on the line after the run and was simply skipped when the script died.

**Fighters are picked by who has played least**, read from `DuelHistory`. This is a correction, not a
preference: at 87 duels two of the six fighters had taken 93% of all slots, because the matrix runs
and the browser tests always choose fighters 0 and 1. A cycle would have taken months to level that.
Note the old fallback made it worse — a failed history read counted as "zero duels", and zero always
selects fighters 0 and 1, the two already over-represented.

Each fixture writes `logs/daily-duel-<market>.log` and, on failure, leaves
`logs/daily-duel-<market>-FAILED`. Per market on purpose: one shared marker meant the evening's
success erased the morning's failure.

## Deploying the front end

There is no git checkout on the box, and no CI. A deploy is three steps, and the
gotchas below are each a real outage or a wasted hour.

```bash
KEY=~/.ssh/coliseum-parakram.pem            # the INSTANCE key pair, not the one in ~/.ssh/config
BOX=ubuntu@13.207.115.250                   # no elastic IP — a restart changes this

scp -i $KEY <changed file> $BOX:/home/ubuntu/app/coliseum/<same path>
ssh -i $KEY $BOX 'cd ~/app/coliseum/frontend && pnpm run build'
ssh -i $KEY $BOX 'pm2 restart coliseum-frontend'
```

- **Copy the changed files. Never `rsync --delete` over `frontend/`.** It removes `frontend/logs/`,
  the process manager then refuses to start, and the public site 502s — measured at about four
  minutes. Recovery is `pm2 delete` then `pm2 start ecosystem.config.js --only coliseum-frontend`,
  because pm2 will list a process it simultaneously claims not to find.
- **The address in `~/.ssh/config` goes stale.** The instance carries no elastic IP, so a restart
  moves it. A dead address times out exactly like a closed firewall, which is how one problem hid
  behind another for a day. Confirm with
  `aws ec2 describe-instances --region ap-south-1 --query 'Reservations[].Instances[].{name:Tags[?Key==\`Name\`]|[0].Value,ip:PublicIpAddress}'`.
- **Port 22 is normally shut.** The security group allows only 80 and 443, from Cloudflare's ranges.
  Open it to a single address for the deploy and revoke it afterwards — never to `0.0.0.0/0`:
  `aws ec2 authorize-security-group-ingress --group-id sg-06eb3df0510b6933f --protocol tcp --port 22 --cidr <your-ip>/32 --region ap-south-1`
- **`npm run lint` in `frontend/` runs out of memory and checks nothing** — it exits with
  `Linter process terminated abnormally`, which is not a pass. Verify frontend work with
  `npx tsc --noEmit` and `pnpm run build`, plus measuring the real DOM in a browser: a green build says
  the code compiles, never that the layout is right. A CSS grid that silently collapsed to one column on
  a phone passed every check except that one.
- **The build fits, but only just** — 3.8 GB of memory with 2 GB of swap, two cores. It takes a
  couple of minutes; do not run two at once.
- Six processes run there: the watcher, the question binder, the seeder, the simulated market maker,
  the house matchmaker, and the front end. Only the last one restarts for a UI change.

## Key addresses (Somnia testnet, chain 50312)

| Contract | Address |
|---|---|
| Arena (router — permanent) | `0x301d9364BDb2fd76E33c13eBE8FCc956BAcfbeD6` |
| Matchmaker | `0x6b7e255a3420c7846a15e963589ffd5504773b0a` |
| Bookmaker | `0x73d0a884f563c454ca0d05bd09b0643c0204b755` |
| DuelHistory | `0x11ac9b65b05dfb1406618bda649b410b8e8f7108` |
| FighterRegistry | `0xefe3dd01c59b435bb688135f19db364ef09e90df` |
| EventTreasury (+ 6 desks) | `0x47dab39e8a6c1e9e8c367576ae225904fc85fbff` |
| USDso (quote token) | `0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171` |
| tUSDC (event collateral) | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| dreamDEX SOMI/USDso | `0x259fD6559214dd5aD3752322426eA9F9fABEFff4` |
| dreamDEX WBTC/USDso | `0x3605f28aA7C50e7441211e77Cb0762d49539326C` |
| dreamDEX WETH/USDso | `0xD180195da5459C7a0DEA188ed61216ec43682b50` |
| FuelPot (turns fees into STT) | `0x1e840a1267148b38d02135b36f1daa50ae329f4c` |
| Somnia Agents platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |

The Arena's part addresses and the six desks live in `coliseum/deployments/somnia.json`, which is
gitignored — the bots need it, or they referee a different Arena than the frontend serves.

Only the Arena's address is permanent: it is a router, so its logic is replaced underneath it without
moving storage or funds. Everything else moves when its code changes, which is why the Bookmaker has
had three addresses. Two are abandoned and should never be funded again — a subscription attached to a
contract keeps spending any balance you send it.

The SOMI book's "base token" is an address with **no code**. It is a sentinel for native STT, not a
token — a detail that costs an afternoon to rediscover.

`FuelPot` is replaceable and holds no player money, so its owner exit is uncapped and it has a
one-call `migrate` to a successor. That is safe *there* and would be theft in the Arena, whose balance
holds players' stakes — the distinction is what a contract holds, not who is asking.

---

[← back to the README](../README.md)
