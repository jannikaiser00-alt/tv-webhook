// index.js
"use strict";

const express = require("express");
const { router } = require("./server");

const app = express();
const PORT = process.env.PORT || 10000;

// Parser
app.use(express.json());

// Bot-Router einhängen (liefert /webhook, /healthz, /debug/*)
app.use("/", router);

// Globaler Fehlerfänger (falls mal was ungefangen bleibt)
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] UnhandledRejection:", err?.stack || err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] UncaughtException:", err?.stack || err);
});

const VERSION = (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || "local";
console.log(`[BOOT] tv-webhook ${VERSION} starting…`);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (v=${VERSION})`);
});
