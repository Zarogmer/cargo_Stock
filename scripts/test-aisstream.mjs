// Quick diagnostic: connect to AIS Stream for 15s and log everything.
// Run with:  node scripts/test-aisstream.mjs
import WebSocket from "ws";
import "dotenv/config";

const KEY = process.env.AISSTREAM_API_KEY;
if (!KEY) {
  console.error("AISSTREAM_API_KEY not set in .env");
  process.exit(1);
}

const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

let msgCount = 0;
let firstMsgAt = null;

ws.on("open", () => {
  console.log("[open] connected, sending subscription...");
  ws.send(
    JSON.stringify({
      APIKey: KEY,
      BoundingBoxes: [
        [
          [-35, -55],
          [-5, -30],
        ],
      ],
    })
  );
});

ws.on("message", (raw) => {
  msgCount++;
  if (!firstMsgAt) firstMsgAt = Date.now();
  const txt = raw.toString();
  if (msgCount <= 5) {
    console.log(`[msg #${msgCount}]`, txt.slice(0, 400));
  } else if (msgCount % 10 === 0) {
    console.log(`[msg #${msgCount}] (silenced)`);
  }
});

ws.on("error", (err) => {
  console.error("[error]", err.message);
});

ws.on("close", (code, reason) => {
  console.log(
    `[close] code=${code} reason=${reason?.toString() || "(none)"} totalMsgs=${msgCount}`
  );
});

setTimeout(() => {
  console.log(`\nReceived ${msgCount} messages in 15s.`);
  if (firstMsgAt) {
    console.log(`First message arrived ${firstMsgAt - startedAt}ms after open.`);
  }
  ws.close();
  setTimeout(() => process.exit(0), 500);
}, 15000);

const startedAt = Date.now();
console.log("Connecting...");
