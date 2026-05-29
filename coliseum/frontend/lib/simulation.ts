export interface Holding {
  token: string;
  amount: number;
  pct: number; // percentage of total portfolio
}

export interface SimState {
  round: number;         // 1–15
  timeLeft: number;      // seconds left in current turn
  countdown: number;     // countdown to next bout (lobby / pre-duel)
  spectators: number;
  pot: number;           // total bet pool in USDso
  potNext: number;       // upcoming match pot
  oddsDegen: number;     // 0-100 (percentage favor for Degen)
  turnIn: number;        // turn indicator (seconds per turn)
  market: {
    bid: number;
    ask: number;
    change: number;
    vol: number;
    buyRatio: number;
  };
  degen: {
    pnl: number;
    thinking: boolean;
    reasoning: string;
    history: number[];
    holdings: Holding[];
  };
  whale: {
    pnl: number;
    thinking: boolean;
    reasoning: string;
    history: number[];
    holdings: Holding[];
  };
  turnCount: number;
  userBet: {
    fighter: 'degen' | 'whale' | null;
    amount: number;
    odds: number;
  } | null;
}

export type SimAction =
  | { type: 'TICK' }
  | { type: 'ADVANCE' }
  | { type: 'FAST_FORWARD' }
  | { type: 'RESET' }
  | { type: 'PLACE_BET'; fighter: 'degen' | 'whale'; amount: number; odds: number };

const DEGEN_REASONINGS = [
  "SOMI is pumping. Just took a massive long. Leverage is my risk manager. SEND IT.",
  "WETH looks primed. Order book is showing thin ask walls. Buying 10 units now!",
  "dreamDEX volume is matching centralized exchanges. SOMI is the future of liquid assets. Sending a full-size market buy.",
  "Taking profits on SOMI now. Flipping into a leveraged long on WBTC. Speed is key!",
  "Buy wall at $17.50 is massive. Front-running the block. Market buy now.",
  "WBTC dump is a clear bear trap. I'm loading the boat here. No stop loss.",
  "Order book looks thin on the ask side. Triggering an aggressive market sweep.",
  "Consolidation is complete. dreamDEX order flow is turning highly bullish. Max size buy!",
];

const WHALE_REASONINGS = [
  "Observing institutional bid interest on SOMI. Placing a patient limit order at support.",
  "Accumulating WETH in small chunks to hide size. Convictions are long-term.",
  "Market volatility is simply noise. Sitting in cash, waiting for degen leverage to flush out.",
  "Order book is highly concentrated. Deploying a portion of our quote vault. Conviction is high.",
  "Liquidity is drying up at local resistance. Taking safe hedge positions on WBTC.",
  "Executing block accumulation. Patient limit fills on SOMI at key horizontal support.",
  "Funding rates are favorable. Hedging base assets while maintaining large spot dominance.",
  "DEX order book imbalance indicates supply exhaustion. Waiting for execution block to clear.",
];

export const makeInitialSim = (): SimState => ({
  round: 1,
  timeLeft: 20,
  countdown: 45,
  spectators: 89,
  pot: 142.50,
  potNext: 24.80,
  oddsDegen: 60,
  turnIn: 20,
  market: {
    bid: 18.42,
    ask: 18.45,
    change: 3.42,
    vol: 84320,
    buyRatio: 0.58,
  },
  degen: {
    pnl: 0.00,
    thinking: false,
    reasoning: "Waiting for the bell. SOMI looks hot today. I'm ready to size up.",
    history: [0.00],
    holdings: [
      { token: 'SOMI', amount: 450, pct: 40 },
      { token: 'USDso', amount: 120, pct: 60 },
      { token: 'WETH', amount: 0, pct: 0 },
    ],
  },
  whale: {
    pnl: 0.00,
    thinking: false,
    reasoning: "Bell in countdown active. Spotting order book patterns on dreamDEX. Waiting for size gaps.",
    history: [0.00],
    holdings: [
      { token: 'SOMI', amount: 200, pct: 15 },
      { token: 'USDso', amount: 480, pct: 85 },
      { token: 'WETH', amount: 0, pct: 0 },
    ],
  },
  turnCount: 0,
  userBet: null,
});

export const simReducer = (state: SimState, action: SimAction): SimState => {
  switch (action.type) {
    case 'TICK': {
      // Lobby and Pre-duel timers
      let nextCountdown = state.countdown - 1;
      if (nextCountdown < 0) {
        nextCountdown = 45; // Reset countdown loop
      }

      // Arena turn timer
      if (state.timeLeft <= 1) {
        // Automatically advance the turn when the clock strikes 0
        return simReducer({ ...state, timeLeft: 20, countdown: nextCountdown }, { type: 'ADVANCE' });
      }

      const nextTimeLeft = state.timeLeft - 1;
      const spectatorsDrift = Math.random() > 0.7 ? (Math.random() > 0.5 ? 1 : -1) : 0;

      return {
        ...state,
        timeLeft: nextTimeLeft,
        countdown: nextCountdown,
        spectators: Math.max(10, state.spectators + spectatorsDrift),
      };
    }

    case 'ADVANCE': {
      if (state.round >= 15) {
        // Stop advancing after round 15 (Max rounds)
        return {
          ...state,
          degen: { ...state.degen, thinking: false },
          whale: { ...state.whale, thinking: false },
          timeLeft: 0,
        };
      }

      const nextRound = state.round + 1;

      // Random Walk portfolio value generation
      // Degen is high risk (high beta variance), Whale is lower variance
      const degenWalk = (Math.random() - 0.48) * 35; // high volatility upwards skew
      const whaleWalk = (Math.random() - 0.5) * 18;  // lower volatility steady walk

      const nextDegenPnl = state.degen.pnl + degenWalk;
      const nextWhalePnl = state.whale.pnl + whaleWalk;

      const nextDegenHistory = [...state.degen.history, nextDegenPnl];
      const nextWhaleHistory = [...state.whale.history, nextWhalePnl];

      // Update Odds dynamically based on cumulative performance
      const pnlDiff = nextDegenPnl - nextWhalePnl;
      let nextOddsDegen = Math.round(50 + pnlDiff * 0.4);
      nextOddsDegen = Math.max(5, Math.min(95, nextOddsDegen)); // clamp between 5% and 95%

      // Pick new reasoning strings
      const degenReason = DEGEN_REASONINGS[Math.floor(Math.random() * DEGEN_REASONINGS.length)];
      const whaleReason = WHALE_REASONINGS[Math.floor(Math.random() * WHALE_REASONINGS.length)];

      // Randomize holdings distribution to show interactive changes
      const somiPrice = 18.0 + (Math.random() - 0.5) * 1.5;
      const nextMarket = {
        bid: Number(somiPrice.toFixed(2)),
        ask: Number((somiPrice + 0.03).toFixed(2)),
        change: Number((state.market.change + (Math.random() - 0.5) * 0.8).toFixed(2)),
        vol: state.market.vol + Math.round(Math.random() * 2500),
        buyRatio: Number((0.35 + Math.random() * 0.3).toFixed(2)),
      };

      const degenSomiAmount = Math.round(450 + nextDegenPnl * 2);
      const degenUsdsoAmount = Math.round(120 - nextDegenPnl * 0.5);
      const degenWethAmount = Math.max(0, Number((0.5 + nextDegenPnl * 0.005).toFixed(2)));

      const whaleSomiAmount = Math.round(200 + nextWhalePnl * 0.8);
      const whaleUsdsoAmount = Math.round(480 - nextWhalePnl * 0.2);
      const whaleWethAmount = Math.max(0, Number((1.2 + nextWhalePnl * 0.002).toFixed(2)));

      return {
        ...state,
        round: nextRound,
        timeLeft: 20,
        oddsDegen: nextOddsDegen,
        market: nextMarket,
        degen: {
          pnl: Number(nextDegenPnl.toFixed(2)),
          thinking: false,
          reasoning: degenReason,
          history: nextDegenHistory,
          holdings: [
            { token: 'SOMI', amount: degenSomiAmount, pct: 35 },
            { token: 'USDso', amount: degenUsdsoAmount, pct: 45 },
            { token: 'WETH', amount: degenWethAmount, pct: 20 },
          ],
        },
        whale: {
          pnl: Number(nextWhalePnl.toFixed(2)),
          thinking: false,
          reasoning: whaleReason,
          history: nextWhaleHistory,
          holdings: [
            { token: 'SOMI', amount: whaleSomiAmount, pct: 15 },
            { token: 'USDso', amount: whaleUsdsoAmount, pct: 60 },
            { token: 'WETH', amount: whaleWethAmount, pct: 25 },
          ],
        },
        turnCount: state.turnCount + 1,
      };
    }

    case 'FAST_FORWARD': {
      // Simulate fast forward to round 15 end state
      let tempState = { ...state };
      for (let i = state.round; i < 15; i++) {
        tempState = simReducer(tempState, { type: 'ADVANCE' });
      }
      return {
        ...tempState,
        timeLeft: 0,
      };
    }

    case 'RESET': {
      return makeInitialSim();
    }

    case 'PLACE_BET': {
      return {
        ...state,
        pot: state.pot + action.amount,
        userBet: {
          fighter: action.fighter,
          amount: action.amount,
          odds: action.odds,
        },
      };
    }

    default:
      return state;
  }
};
