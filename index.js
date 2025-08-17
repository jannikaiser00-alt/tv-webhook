// index.js – Webhook-Server mit Express

"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const { fetchCandles, fetchBookTicker } = require("./server");

const app = express();
const PORT = process.env.PORT || 10000;

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

    // Beispiel: aktuelle Marktdaten abrufen
    const candles = await fetchCandles(symbol);
    const book = await fetchBookTicker(symbol);

    console.log(`[MARKET] ${symbol} 📈 lastClose=${candles.lastClose} | bid=${book.bid} ask=${book.ask}`);

    // Platz für eigene Bot-Logik mit den Daten (z.B. Entry prüfen)

    res.status(200).send("✅ Webhook empfangen und verarbeitet");
  } catch (err) {
    console.error("❌ Fehler beim Verarbeiten des Webhooks:", err.message);
    res.status(500).send("❌ Interner Serverfehler");
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] tv-webhook ${process.env.RENDER_GIT_COMMIT || "dev"} starting…`);
  console.log(`Server running on port ${PORT}`);
});
