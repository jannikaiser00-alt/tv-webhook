// index.js – Webhook-Server mit Express

"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const { fetchCandles, fetchBookTicker } = require("./server");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Health Check
app.get("/", (req, res) => {
  res.status(200).send("✅ TV-Bot online");
});

// Webhook-Route von TradingView
app.post("/webhook", async (req, res) => {
  const payload = req.body;

  console.log("[WEBHOOK] Eingehend:", JSON.stringify(payload));

  if (!payload || !payload.symbol || !payload.side) {
    return res.status(400).send("❌ Ungültiges Format – symbol/side fehlt");
  }

  try {
    const { symbol, side } = payload;

    // Beispiel: Nutze deine Retry/Caching Funktionen
    const candles = await fetchCandles(symbol, "15m", 200);
    const book = await fetchBookTicker(symbol);

    console.log(`[BOT] ${symbol} - LastClose: ${candles.lastClose}, Bid: ${book.bid}, Ask: ${book.ask}`);

    // Später echte Entscheidung hier einbauen (Trend, RSI etc.)
    res.status(200).send("✅ Webhook angenommen");
  } catch (err) {
    console.error("[ERROR] Webhook-Fetch fehlgeschlagen:", err.message);
    res.status(500).send("❌ Interner Fehler beim Verarbeiten des Webhooks");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook-Server läuft auf Port ${PORT}`);
});
