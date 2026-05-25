import WebSocket from "ws";

const WS = "wss://stg.api.dreamdex.io/v0/ws/public";
const ws = new WebSocket(WS);

ws.on("open", () => {
  console.log("Connected");
  ws.send(JSON.stringify({
    operation: "subscribe", channel: "orderbook",
    params: { symbols: ["SOMI:USDso"] },
  }));
});

let gotData = false;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.channel === "orderbook" && msg.bids !== undefined) {
    gotData = true;
    console.log("Type:", msg.type);
    console.log("Bids (top 5):", JSON.stringify(msg.bids?.slice(0, 5), null, 2));
    console.log("Asks (top 5):", JSON.stringify(msg.asks?.slice(0, 5), null, 2));
    ws.close();
    process.exit(0);
  } else {
    console.log("Msg:", JSON.stringify(msg).slice(0, 200));
  }
});

setTimeout(() => {
  if (!gotData) {
    console.log("Timeout — no orderbook data after 15s");
    ws.close();
    process.exit(1);
  }
}, 15_000);
