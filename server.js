// server.js
"use strict";

const express = require("express");
const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const WebSocket = require("ws");

const router = express.Router();

// Body-Parser für JSON & URL-Encoded (damit req.body befüllt ist)
router.use(express.json({ limit: "1mb" }));
router.use(express.urlencoded({ extended: true }));


// ===================== VERSION =====================
const VERSION = (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || "local";

// ===================== ENV / KONFIG =====================
// Security / Behaviour
const TV_SECRET        = (process.env.TV_SECRET || "").trim();     // muss zum Pine "webhookSecret" passen
const SENTI_MODE       = (process.env.SENTI_MODE || "strict").toLowerCase(); // 'strict'|'lenient'

// Risk / Targets
const MIN_RR           = parseFloat(process.env.MIN_RR || "3.0");   // Mindest-CRV 1:3
const ATR_MULT         = parseFloat(process.env.ATR_MULT || "1.2"); // Fallback-Distanz für SL
const AUTO_ADJUST_TP   = (process.env.AUTO_ADJUST_TP || "true").toLowerCase() === "true";

// Market / Data
const EXCHANGE_BASE    = process.env.EXCHANGE_BASE || "https://api.binance.com";
const MARKET_INTERVAL  = process.env.MARKET_INTERVAL || "15m";      // 1m/5m/15m/1h...
const CANDLE_LIMIT     = parseInt(process.env.CANDLE_LIMIT || "400", 10);

// Risk & Control
const DAILY_RISK_BUDGET_USD = parseFloat(process.env.DAILY_RISK_BUDGET_USD || "300");
const MAX_TRADES_PER_DAY    = parseInt(process.env.MAX_TRADES_PER_DAY || "40", 10);
const ACCEPT_OLD_MS         = parseInt(process.env.ACCEPT_OLD_MS || "120000", 10);
const DUP_TTL_MS            = parseInt(process.env.DUP_TTL_MS || "300000", 10);
const MIN_MS_BETWEEN_TRADES = parseInt(process.env.MIN_MS_BETWEEN_TRADES || "15000", 10);

// Markt-Qualität
const SPREAD_MAX_BPS        = parseFloat(process.env.SPREAD_MAX_BPS || "8");   // 8 bp = 0.08%
const Z_ATR_MAX             = parseFloat(process.env.Z_ATR_MAX || "2.8");      // Volatility Brake

// Rounding Fallbacks (falls Exchange-Info nicht erreichbar)
const FALLBACK_PRICE_TICK   = parseFloat(process.env.PRICE_TICK || "0");
const FALLBACK_LOT_STEP     = parseFloat(process.env.LOT_STEP || "0");
const FALLBACK_MIN_NOTIONAL = parseFloat(process.env.MIN_NOTIONAL_USD || "5");

// Logging / Debug
const LOG_DECISIONS         = (process.env.LOG_DECISIONS || "true").toLowerCase() === "true";
const DECISION_BUFFER       = parseInt(process.env.DECISION_BUFFER || "200", 10);

// Debug-Schutz (optional)
function requireSecret(req, res, next) {
  const authHeader = req.get("authorization") || "";
  const fromBearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const clientSecret = (
    req.get("x-tv-secret") ||
    fromBearer ||
    (req.query.secret || req.body?.secret || "")
  ).toString().trim();

  if (!TV_SECRET || clientSecret !== TV_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized_debug" });
  }
  next();
}
// ===================== TELEGRAM (via ./telegram) =====================
let tg; try { tg = require("./telegram"); } catch { tg = null; }


// ===================== HTTP CLIENT (mit Retry) =====================
const http = axios.create({
  baseURL: EXCHANGE_BASE,
  timeout: 10000,
  headers: { "User-Agent": "tv-webhook/1.0" },
});

axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    !err.response || [418, 429, 500, 502, 503, 504].includes(err.response.status),
});

// ===================== CACHES =====================
const candlesCache  = new Map(); // key: symbol_interval -> { ts, data }
const bookCache     = new Map(); // key: symbol -> { ts, data }
const exchInfoCache = new Map(); // key: symbol -> { ts, tickSize, stepSize, minNotional }

// ===================== STATE / SPEICHER =====================
const state = {
  dayKey: null,                // "YYYY-MM-DD" (UTC)
  riskUsedUsd: 0,
  tradesAccepted: 0,
  tradesRejected: 0,
  perSymbolLastTs: new Map(),  // symbol -> last accept ts
  seenIds: new Map(),          // id -> ts (Idempotenz)
  decisions: [],               // ring buffer
  rejectReasons: new Map(),    // reason -> count

  // === Paper Trading Simulation ===
  paperWallet: {
    balanceUsd: 10000,   // Start-Kapital
    openTrades: [],      // laufende Trades
    closedTrades: []     // abgeschlossene Trades
  }
};

// === Day rotation / decision buffer ===
function todayKeyUTC() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function rotateDayIfNeeded() {
  const k = todayKeyUTC();
  if (state.dayKey !== k) {
    state.dayKey = k;
    state.riskUsedUsd = 0;
    state.tradesAccepted = 0;
    state.tradesRejected = 0;
    state.perSymbolLastTs.clear();
    state.seenIds.clear();
    state.decisions = [];
    state.rejectReasons.clear();
  }
}
function pushDecision(entry) {
  state.decisions.push(entry);
  if (state.decisions.length > DECISION_BUFFER) state.decisions.shift();
}

// === Log helpers ===
function logReject(reason, ctx = {}) {
  const t = new Date().toISOString();
  const meta = [];
  if (ctx.symbol) meta.push(ctx.symbol);
  if (ctx.side)   meta.push(ctx.side.toUpperCase());
  if (ctx.gridIndex !== undefined) meta.push(`#${ctx.gridIndex}`);
  const metaStr = meta.length ? ` [${meta.join(" ")}]` : "";
  console.log(`[REJECT] ${reason}${metaStr} @ ${t}`);
}
function logAccept(ctx = {}) {
  const t = new Date().toISOString();
  const { symbol, side, entry, sl, tp, rr } = ctx;
  console.log(`[ACCEPT] ${side?.toUpperCase?.()} ${symbol} @${entry} SL ${sl} TP ${tp} RR=${rr} @ ${t}`);
}

// === Math/rounding utils ===
function roundToStep(v, step) { if (!step || step <= 0) return v; return Math.round(v / step) * step; }
function ceilToStep(v, step)  { if (!step || step <= 0) return v; return Math.ceil(v / step)  * step; }
function floorToStep(v, step) { if (!step || step <= 0) return v; return Math.floor(v / step) * step; }
function rr(entry, sl, tp, side) {
  if ([entry, sl, tp].some(x => x == null || isNaN(x))) return null;
  if (side === "buy")  return (tp - entry) / Math.max(1e-9, (entry - sl));
  if (side === "sell") return (entry - tp) / Math.max(1e-9, (sl - entry));
  return null;
}
function zscore(arr, len = 120) {
  if (!Array.isArray(arr) || arr.length < len) return null;
  const s = arr.slice(-len);
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) * (b - m), 0) / s.length) || 1e-9;
  return (s[s.length - 1] - m) / sd;
}



// ===== PAPER: settle helper (schließt offene Paper-Trades bei SL/TP) =====
function settlePaperForSymbol(symbol, mid) {
  if (!Number.isFinite(mid)) return;
  const w = state.paperWallet;
  if (!w || !Array.isArray(w.openTrades)) return;

  for (let i = w.openTrades.length - 1; i >= 0; i--) {
    const t = w.openTrades[i];
    if (!t || t.symbol !== symbol) continue;

    const isBuy  = t.side === "buy";
    const hitSL  = isBuy ? mid <= t.sl : mid >= t.sl;
    const hitTP  = isBuy ? mid >= t.tp : mid <= t.tp;
    if (!hitSL && !hitTP) continue;

    const exit = hitTP ? t.tp : t.sl;
    const pnl  = (isBuy ? (exit - t.entry) : (t.entry - exit)) * t.qty;

    w.balanceUsd += pnl;

    w.openTrades.splice(i, 1);
    const closed = {
      ...t,
      exit,
      tsClose: Date.now(),
      reason: hitTP ? "TP" : "SL",
      pnl
    };
    w.closedTrades.push(closed);

    console.log(
      `[PAPER] Closed ${t.side.toUpperCase()} ${t.symbol} @${exit} (${closed.reason}) PnL=${pnl.toFixed(2)} USD`
    );

    // Telegram-Notify (aus telegram.js)
    try { tg?.tradeClosed?.(closed); } catch (e) {
      console.error("[PAPER→TG] notify failed:", e?.message || e);
    }
  }
}

// ===================== [WS] WEBSOCKET CLIENT =====================
let ws;
function startWS(symbol = "SOLUSDT", interval = MARKET_INTERVAL) {
  const streams = [
    `${symbol.toLowerCase()}@bookTicker`,
    `${symbol.toLowerCase()}@kline_${interval}`
  ].join("/");

  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  ws = new WebSocket(url);

  ws.on("open", () => {
    console.log(`[WS] Connected to Binance streams: ${streams}`);
    // Telegram-Notify (optional-sicher)
    try { if (typeof tg?.wsUp === "function") tg.wsUp(streams); } catch (e) {
      console.warn("[TG] wsUp failed:", e?.message || e);
    }
  });

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      const data = parsed?.data;

      // BookTicker Event
      if (data?.e === "bookTicker") {
        const s   = symbol.toUpperCase();
        const bid = parseFloat(data.b);
        const ask = parseFloat(data.a);

        if (Number.isFinite(bid) && Number.isFinite(ask)) {
          bookCache.set(s, {
            ts: Date.now(),
            data: { bid, ask },
          });

          // ➜ Realtime: Paper-Trades mit aktuellem Mid-Preis prüfen & ggf. schließen
          const mid = (bid + ask) / 2;
          settlePaperForSymbol(s, mid);
        }
      }

      // Kline Event
      if (data?.e === "kline") {
        const k = data.k;
        if (k) {
          const key = `${symbol.toUpperCase()}_${interval}`;
          const h = parseFloat(k.h);
          const l = parseFloat(k.l);
          const c = parseFloat(k.c);
          if ([h, l, c].every(Number.isFinite)) {
            const out = {
              highs: [h],
              lows: [l],
              closes: [c],
              lastClose: c,
            };
            candlesCache.set(key, { ts: Date.now(), data: out });
          }
        }
      }
    } catch (err) {
      console.error("[WS ERROR message]", err?.message || err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] Disconnected (code=${code || 0}) – retrying in ~5s...`);
    // Telegram-Notify (optional-sicher)
    try { if (typeof tg?.wsDown === "function") tg.wsDown(); } catch (e) {
      console.warn("[TG] wsDown failed:", e?.message || e);
    }
    // kleiner Jitter, um Reconnect-Stürme zu vermeiden
    const delay = 5000 + Math.floor(Math.random() * 2000);
    setTimeout(() => startWS(symbol, interval), delay);
  });

  ws.on("error", (err) => {
    console.error("[WS ERROR socket]", err?.message || err);
    try { ws.close(); } catch {}
  });
}

// Start WebSocket beim Boot
startWS("SOLUSDT", MARKET_INTERVAL);

// ===================== INDICATORS =====================
function ema(values, len) {
  if (!values || values.length < len) return null;
  const k = 2 / (len + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(closes, len = 14) {
  if (!closes || closes.length < len + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= len; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  gains /= len; losses /= len;
  let rs = losses === 0 ? 100 : gains / (losses || 1e-9);
  let r = 100 - (100 / (1 + rs));
  for (let i = len + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    gains = (gains * (len - 1) + gain) / len;
    losses = (losses * (len - 1) + loss) / len;
    rs = losses === 0 ? 100 : gains / (losses || 1e-9);
    r = 100 - (100 / (1 + rs));
  }
  return r;
}
function atr(highs, lows, closes, len = 14) {
  if (!highs || highs.length < len + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = 0;
  for (let i = 0; i < len; i++) a += trs[i];
  a /= len;
  for (let i = len; i < trs.length; i++) a = (a * (len - 1) + trs[i]) / len;
  return { atr: a, trs };
}
function sentimentScore({ closes, highs, lows }) {
  const last200 = closes.slice(-200);
  const ema50  = ema(last200, 50);
  const ema200 = ema(last200, 200);
  const rsi14  = rsi(last200, 14);
  const { atr: atr14, trs } = atr(highs.slice(-200), lows.slice(-200), closes.slice(-200), 14) || {};
  const zAtr   = zscore(trs || [], 120);
  const last   = closes[closes.length - 1];

  const upTrend   = ema50 != null && ema200 != null && ema50 > ema200 && last > ema50;
  const downTrend = ema50 != null && ema200 != null && ema50 < ema200 && last < ema50;

  const rsiOKLong  = rsi14 != null && rsi14 > 42 && rsi14 < 72;
  const rsiOKShort = rsi14 != null && rsi14 > 28 && rsi14 < 58;

  return { ema50, ema200, rsi14, atr14, zAtr, last, upTrend, downTrend, rsiOKLong, rsiOKShort };
}

// ===================== EXCHANGE DATA (Binance public) =====================

async function fetchCandles(symbol = "SOLUSDT", interval = "15m", limit = CANDLE_LIMIT) {
  // 👉 Key ohne limit, damit WS-Stream immer trifft
  const key = `${symbol.toUpperCase()}_${interval}`;
  const cached = candlesCache.get(key);

  // Mindestlänge für Indikatoren: wir brauchen History (EMA200/ATR/RSI)
  const NEED = Math.max(120, Math.min(400, Number(limit) || 400));

  // Nur benutzen, wenn WS-Cache genug Historie hat
  if (cached && Date.now() - cached.ts < 15_000) {
    const cd = cached.data || {};
    const have = Array.isArray(cd.closes) ? cd.closes.length : 0;
    if (have >= NEED) return cd;
    // sonst: bewusst auf HTTP-Historie fallen
  }

  // Fallback: vollständige Historie via HTTP
  const httpLimit = Math.max(NEED, 200); // etwas großzügig, damit EMA200 sicher geht
  const { data } = await http.get("/api/v3/klines", {
    params: { symbol: symbol.toUpperCase(), interval, limit: httpLimit },
  });

  const highs  = data.map(d => parseFloat(d[2]));
  const lows   = data.map(d => parseFloat(d[3]));
  const closes = data.map(d => parseFloat(d[4]));
  const out = { highs, lows, closes, lastClose: closes[closes.length - 1] };

  candlesCache.set(key, { ts: Date.now(), data: out });
  return out;
}

async function fetchBookTicker(symbol = "SOLUSDT") {
  const s = symbol.toUpperCase();
  const cached = bookCache.get(s);
  if (cached && Date.now() - cached.ts < 5_000) return cached.data; // 5s TTL

  const { data } = await http.get("/api/v3/ticker/bookTicker", {
    params: { symbol: s },
  });
  const out = { bid: parseFloat(data.bidPrice), ask: parseFloat(data.askPrice) };
  bookCache.set(s, { ts: Date.now(), data: out });
  return out;
}
async function fetchSymbolFilters(symbol = "SOLUSDT") {
  const s = symbol.toUpperCase();
  const cached = exchInfoCache.get(s);
  const now = Date.now();
  if (cached && now - cached.ts < 60_000) return cached; // 60s TTL

  try {
    const { data } = await http.get("/api/v3/exchangeInfo", { params: { symbol: s } });
    const info = data.symbols && data.symbols[0];
    if (!info || !info.filters) throw new Error("exchangeInfo: symbol not found");

    let tickSize = FALLBACK_PRICE_TICK;
    let stepSize = FALLBACK_LOT_STEP;
    let minNotional = FALLBACK_MIN_NOTIONAL;

    for (const f of info.filters) {
      if (f.filterType === "PRICE_FILTER") tickSize = parseFloat(f.tickSize);
      if (f.filterType === "LOT_SIZE")     stepSize = parseFloat(f.stepSize);
      if (f.filterType === "MIN_NOTIONAL") minNotional = parseFloat(f.minNotional);
    }

    const out = { tickSize, stepSize, minNotional, ts: now };
    exchInfoCache.set(s, out);
    return out;
  } catch {
    const out = { tickSize: FALLBACK_PRICE_TICK, stepSize: FALLBACK_LOT_STEP, minNotional: FALLBACK_MIN_NOTIONAL, ts: now };
    exchInfoCache.set(s, out);
    return out;
  }
}

// ===================== SAFETY / HOUSEKEEPING =====================
function stale(tsMs) {
  if (!tsMs || !isFinite(tsMs)) return false;
  const age = Date.now() - Number(tsMs);
  return age > ACCEPT_OLD_MS;
}
function seenBefore(id, ttl = DUP_TTL_MS) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, v] of state.seenIds) if (now - v > ttl) state.seenIds.delete(k);
  if (state.seenIds.has(id)) return true;
  state.seenIds.set(id, now);
  return false;
}
function symbolThrottled(symbol) {
  const now = Date.now();
  const last = state.perSymbolLastTs.get(symbol) || 0;
  if (now - last < MIN_MS_BETWEEN_TRADES) return true;
  state.perSymbolLastTs.set(symbol, now);
  return false;
}

// ===================== ROUTES =====================

// Health
router.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: VERSION });
});

// Debug Env
router.get("/debug/env", requireSecret, (req, res) => {
  res.json({
    hasSecret: TV_SECRET.length > 0,
    minRR: MIN_RR, atrMult: ATR_MULT, interval: MARKET_INTERVAL,
    sentiMode: SENTI_MODE, autoAdjustTP: AUTO_ADJUST_TP,
    budgets: { DAILY_RISK_BUDGET_USD, MAX_TRADES_PER_DAY },
    quality: { SPREAD_MAX_BPS, Z_ATR_MAX },
    staleMs: ACCEPT_OLD_MS, dupTtlMs: DUP_TTL_MS, throttleMs: MIN_MS_BETWEEN_TRADES,
    version: VERSION
  });
});

// Debug State (robust, einmalig)
router.get("/debug/state", requireSecret, (req, res) => {
  try {
    rotateDayIfNeeded();

    const dayKey         = state?.dayKey ?? null;
    const riskUsedUsd    = Number(state?.riskUsedUsd ?? 0);
    const tradesAccepted = Number(state?.tradesAccepted ?? 0);
    const tradesRejected = Number(state?.tradesRejected ?? 0);
    const cachedSymbols  = exchInfoCache ? Array.from(exchInfoCache.keys()) : [];

    return res.json({
      ok: true,
      dayKey,
      riskUsedUsd,
      tradesAccepted,
      tradesRejected,
      cachedSymbols
    });
  } catch (err) {
    console.error("[/debug/state] failed:", err?.stack || err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "unknown_error_in_debug_state"
    });
  }
});

// Debug Decisions
router.get("/debug/decisions", requireSecret, (req, res) => {
  const limit  = Math.max(1, Math.min(1000, parseInt(req.query.limit || "100", 10)));
  const symbol = (req.query.symbol || "").toUpperCase();
  const rows = state.decisions
    .filter(d => !symbol || d.symbol === symbol)
    .slice(-limit);
  res.json({ count: rows.length, rows });
});

// Debug Summary
router.get("/debug/summary", requireSecret, (req, res) => {
  const reasons = Array.from(state.rejectReasons.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
  res.json({
    dayKey: state.dayKey,
    tradesAccepted: state.tradesAccepted,
    tradesRejected: state.tradesRejected,
    riskUsedUsd: +state.riskUsedUsd.toFixed(2),
    topRejectReasons: reasons
  });
});

// Debug WS (Status des WebSocket-Streams prüfen)
router.get("/debug/ws", requireSecret, (req, res) => {
  const s = {
    ready: ws && ws.readyState === 1,
    state: ws ? ws.readyState : null,
    haveBook: Array.from(bookCache.keys()),
    haveCandles: Array.from(candlesCache.keys()),
    ts: new Date().toISOString()
  };
  res.json(s);
});

// Debug Paper-Trading: Wallet + PnL
router.get("/debug/paper", requireSecret, (req, res) => {
  try {
    // Mid-Preise aus Book-Cache (falls vorhanden) für uPnL
    const midBy = {};
    for (const s of new Set(state.paperWallet.openTrades.map(t => t.symbol))) {
      const book = bookCache.get(s)?.data;
      if (book && Number.isFinite(book.bid) && Number.isFinite(book.ask)) {
        midBy[s] = (book.bid + book.ask) / 2;
      }
    }

    const open = state.paperWallet.openTrades.map(t => {
      const mid = midBy[t.symbol];
      const uPnL = Number.isFinite(mid)
        ? (t.side === "buy" ? (mid - t.entry) : (t.entry - mid)) * t.qty
        : 0;
      return {
        ...t,
        mid: Number.isFinite(mid) ? mid : null,
        uPnL: +uPnL.toFixed(4)
      };
    });

    const realized   = state.paperWallet.closedTrades.reduce((a, c) => a + (c.pnl || 0), 0);
    const unrealized = open.reduce((a, c) => a + (c.uPnL || 0), 0);

    res.json({
      balanceUsd:     +state.paperWallet.balanceUsd.toFixed(2),
      realizedPnL:    +realized.toFixed(2),
      unrealizedPnL:  +unrealized.toFixed(2),
      // ✅ Equity = Balance (inkl. realized) + unrealized
      equityUsd:      +(state.paperWallet.balanceUsd + unrealized).toFixed(2),
      openCount:      open.length,
      open,
      closedCount:    state.paperWallet.closedTrades.length,
      closedLast50:   state.paperWallet.closedTrades.slice(-50)
    });
  } catch (err) {
    console.error("[/debug/paper] failed:", err?.stack || err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || "paper_debug_failed" });
  }
});

// Debug Paper-Trading: Wallet resetten (POST, optional ?balance=12345)
router.post("/debug/paper/reset", requireSecret, (req, res) => {
  try {
    const start = Number(req.query.balance ?? req.body?.balance ?? 10000);
    state.paperWallet.balanceUsd = Number.isFinite(start) ? start : 10000;
    state.paperWallet.openTrades = [];
    state.paperWallet.closedTrades = [];
    return res.json({
      ok: true,
      balanceUsd: +state.paperWallet.balanceUsd.toFixed(2),
      message: "paper wallet reset"
    });
  } catch (err) {
    console.error("[/debug/paper/reset] failed:", err?.stack || err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || "paper_reset_failed" });
  }
});

// ===================== WEBHOOK CORE =====================
router.post("/webhook", async (req, res) => {
  try {
    rotateDayIfNeeded();

    const pRaw = req.body || {};

    // --- Secret prüfen ---
    const authHeader = req.get("authorization") || "";
    const fromBearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const clientSecret = (
      (pRaw && pRaw.secret) ||
      req.get("x-tv-secret") ||
      fromBearer ||
      ""
    ).toString().trim();

    if (!TV_SECRET) {
      logReject("server_secret_missing");
      return res.status(500).json({ ok: false, error: "server_secret_missing" });
    }
    if (!clientSecret) {
      logReject("client_secret_missing");
      return res.status(401).json({ ok: false, error: "client_secret_missing" });
    }
    if (clientSecret !== TV_SECRET) {
      logReject("secret_mismatch");
      return res.status(401).json({ ok: false, error: "secret_mismatch" });
    }

    // --- PING / STATUS (frühe Rückgabe) ---
    const cmd        = (pRaw.cmd || "").toLowerCase();
    const reasonFlag = (pRaw.reason || "").toLowerCase();
    if (cmd === "ping" || cmd === "status" || reasonFlag === "ping" || reasonFlag === "status") {
      const symbolPing = (pRaw.symbol || "SOLUSDT").toUpperCase();
      console.log(`[INFO] Heartbeat/Status: ${symbolPing} @ ${new Date().toISOString()}`);
      return res.json({
        ok: true,
        kind: "PING_ACK",
        serverTime: new Date().toISOString(),
        version: VERSION,
        state: {
          dayKey: state.dayKey,
          riskUsedUsd: +state.riskUsedUsd.toFixed(2),
          tradesAccepted: state.tradesAccepted,
          tradesRejected: state.tradesRejected
        }
      });
    }

    // --- Pflichtfelder / Parsing ---
    const side   = (pRaw.side || "").toLowerCase(); // buy/sell
    const symbol = (pRaw.symbol || "SOLUSDT").toUpperCase();
    const px     = Number(pRaw.px);
    let   sl     = pRaw.sl != null ? Number(pRaw.sl) : null;
    let   tp     = pRaw.tp != null ? Number(pRaw.tp) : null;
    const qtyUsd = pRaw.qtyUsd != null ? Number(pRaw.qtyUsd) : null;
    const id     = (pRaw.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`).toString();
    const ts     = Number(pRaw.ts || Date.now());

    if (!(side === "buy" || side === "sell")) {
      logReject("bad_side", { symbol, side });
      return res.status(400).json({ ok: false, error: "bad_side" });
    }
    if (!isFinite(px)) {
      logReject("bad_px", { symbol, side });
      return res.status(400).json({ ok: false, error: "bad_px" });
    }

    // --- Idempotenz & Stale ---
    if (seenBefore(id)) {
      logReject("duplicate_dropped", { symbol, side });
      return res.json({ ok: true, decision: "DUPLICATE_DROPPED", id });
    }
    if (stale(ts)) {
      state.tradesRejected++;
      state.rejectReasons.set("stale_alert", (state.rejectReasons.get("stale_alert") || 0) + 1);
      logReject("stale_alert", { symbol, side });
      return res.json({ ok: true, decision: "REJECT", reason: "stale_alert", ageMs: Date.now() - ts });
    }

    // --- Marktdaten & Indikatoren ---
    const [candles, book] = await Promise.all([
      fetchCandles(symbol, MARKET_INTERVAL, CANDLE_LIMIT),
      fetchBookTicker(symbol).catch(() => ({ bid: px * 0.999, ask: px * 1.001 }))
    ]);

    const senti = sentimentScore(candles);
    if (senti.atr14 == null || senti.ema50 == null || senti.ema200 == null || senti.rsi14 == null) {
      logReject("indicator_insufficient_data", { symbol, side });
      return res.status(500).json({ ok: false, error: "indicator_insufficient_data" });
    }

    // --- Spread Gate ---
    const spread = Math.max(0, (book.ask - book.bid));
    const mid    = (book.ask + book.bid) / 2;

    // Paper-Trades gegen aktuellen Mid prüfen
    settlePaperForSymbol(symbol, mid);

    const spreadBps = mid > 0 ? (spread / mid) * 1e4 : 9999;
    if (spreadBps > SPREAD_MAX_BPS) {
      state.tradesRejected++;
      state.rejectReasons.set("SpreadTooWide", (state.rejectReasons.get("SpreadTooWide") || 0) + 1);
      logReject("SpreadTooWide", { symbol, side });
      return res.json({ ok: true, decision: "REJECT", reason: "SpreadTooWide", spreadBps, limitBps: SPREAD_MAX_BPS });
    }

    // --- Volatility Brake (ATR Z-Score) ---
    if (senti.zAtr != null && senti.zAtr > Z_ATR_MAX) {
      state.tradesRejected++;
      state.rejectReasons.set("VolSpike", (state.rejectReasons.get("VolSpike") || 0) + 1);
      logReject("VolSpike", { symbol, side });
      return res.json({ ok: true, decision: "REJECT", reason: "VolSpike", zAtr: senti.zAtr, zAtrMax: Z_ATR_MAX });
    }

    // --- SL/TP ergänzen falls fehlend ---
    if (sl == null || tp == null) {
      const dist = senti.atr14 * ATR_MULT;
      if (side === "buy") {
        sl = sl == null ? (px - dist) : sl;
        tp = tp == null ? (px + dist * Math.max(MIN_RR, 3.0)) : tp;
      } else {
        sl = sl == null ? (px + dist) : sl;
        tp = tp == null ? (px - dist * Math.max(MIN_RR, 3.0)) : tp;
      }
    }

    // --- SL/TP Sanity ---
    if (side === "buy") {
      if (!(sl < px && tp > px)) {
        const risk = Math.max(1e-9, (px - sl || senti.atr14 * ATR_MULT));
        sl = Math.min(sl, px - risk);
        const wantTp = px + Math.max(MIN_RR, 3.0) * (px - sl);
        tp = Math.max(tp, wantTp);
      }
    } else {
      if (!(sl > px && tp < px)) {
        const risk = Math.max(1e-9, (sl - px || senti.atr14 * ATR_MULT));
        sl = Math.max(sl, px + risk);
        const wantTp = px - Math.max(MIN_RR, 3.0) * (sl - px);
        tp = Math.min(tp, wantTp);
      }
    }

    // --- RR prüfen / ggf. TP nachziehen ---
    let rrNow = rr(px, sl, tp, side);
    let rrAdjusted = false;
    if (rrNow == null) {
      logReject("rr_compute_failed", { symbol, side });
      return res.status(400).json({ ok: false, error: "rr_compute_failed" });
    }
    if (rrNow < MIN_RR && AUTO_ADJUST_TP) {
      const risk = side === "buy" ? (px - sl) : (sl - px);
      tp = side === "buy" ? (px + MIN_RR * risk) : (px - MIN_RR * risk);
      rrNow = rr(px, sl, tp, side);
      rrAdjusted = true;
    }

    // --- Sentiment-Gates ---
    const trendOK   = (side === "buy") ? senti.upTrend   : senti.downTrend;
    const rsiOK     = (side === "buy") ? senti.rsiOKLong : senti.rsiOKShort;
    const rrOK      = rrNow >= MIN_RR;

    const passStrict  = rrOK && trendOK && rsiOK;
    const passLenient = rrOK && (trendOK || rsiOK);
    const acceptSenti = SENTI_MODE === "strict" ? passStrict : passLenient;

    // --- Symbol-Throttle ---
    if (symbolThrottled(symbol)) {
      state.tradesRejected++;
      state.rejectReasons.set("SymbolThrottle", (state.rejectReasons.get("SymbolThrottle") || 0) + 1);
      logReject("SymbolThrottle", { symbol, side });
      return res.json({ ok: true, decision: "REJECT", reason: "SymbolThrottle", throttleMs: MIN_MS_BETWEEN_TRADES });
    }

    // --- Tageslimits (Budget & Trades) ---
    if (state.tradesAccepted >= MAX_TRADES_PER_DAY) {
      state.tradesRejected++;
      state.rejectReasons.set("MaxTradesDay", (state.rejectReasons.get("MaxTradesDay") || 0) + 1);
      logReject("MaxTradesDay", { symbol, side });
      return res.json({ ok: true, decision: "REJECT", reason: "MaxTradesDay", max: MAX_TRADES_PER_DAY });
    }

    // --- Sizing (Exchange-Filter) ---
    const filters = await fetchSymbolFilters(symbol);
    const notionalTarget = Math.max(
      Number.isFinite(qtyUsd) ? qtyUsd : filters.minNotional,
      filters.minNotional
    );

    let qty = notionalTarget / px;
    if (filters.stepSize > 0) qty = floorToStep(qty, filters.stepSize);
    if (qty <= 0) {
      state.tradesRejected++;
      state.rejectReasons.set("QtyTooSmall", (state.rejectReasons.get("QtyTooSmall") || 0) + 1);
      logReject("QtyTooSmall", { symbol, side });
      return res.json({
        ok: true,
        decision: "REJECT",
        reason: "QtyTooSmall",
        step: filters.stepSize,
        minNotional: filters.minNotional
      });
    }

    let notional = qty * px;
    if (notional < filters.minNotional) {
      qty = ceilToStep(filters.minNotional / px, filters.stepSize || 0);
      notional = qty * px;
    }

    const entry = filters.tickSize > 0 ? roundToStep(px,  filters.tickSize) : px;
    const slR   = filters.tickSize > 0 ? roundToStep(sl,  filters.tickSize) : sl;
    const tpR   = filters.tickSize > 0 ? roundToStep(tp,  filters.tickSize) : tp;

    // --- Risk USD für Budget ---
    const riskPerUnit  = side === "buy" ? (entry - slR) : (slR - entry);
    const tradeRiskUsd = Math.max(0, riskPerUnit) * qty;

    if (DAILY_RISK_BUDGET_USD > 0 && (state.riskUsedUsd + tradeRiskUsd) > DAILY_RISK_BUDGET_USD) {
      state.tradesRejected++;
      state.rejectReasons.set("DailyRiskBudget", (state.rejectReasons.get("DailyRiskBudget") || 0) + 1);
      logReject("DailyRiskBudget", { symbol, side });
      try { tg?.budgetHit?.({ riskUsedUsd: state.riskUsedUsd, tradeRiskUsd, limit: DAILY_RISK_BUDGET_USD }); } catch {}
      return res.json({
        ok: true,
        decision: "REJECT",
        reason: "DailyRiskBudget",
        riskUsedUsd: state.riskUsedUsd,
        tradeRiskUsd,
        limit: DAILY_RISK_BUDGET_USD
      });
    }

    // --- Finale Entscheidung ---
    const accept = acceptSenti;
    const reasons = [];
    if (!rrOK)    reasons.push(`RR<${MIN_RR}`);
    if (!trendOK) reasons.push("TrendMismatch");
    if (!rsiOK)   reasons.push("RSIContextBad");

    const spreadBpsFixed = +spreadBps.toFixed(3);

    const payload = {
      ok: true,
      decision: accept ? "ACCEPT" : "REJECT",
      wouldPlace: accept,
      action: accept ? "PLACE_ORDER" : "SKIP",
      mode: SENTI_MODE,
      reasonsRejected: accept ? [] : reasons,
      order: {
        id, side, symbol,
        entry, sl: slR, tp: tpR,
        rr: +rrNow.toFixed(3), rrAdjusted,
        qty,
        notional: +(qty * entry).toFixed(4),
        riskUsd: +tradeRiskUsd.toFixed(4)
      },
      indicators: {
        ema50: senti.ema50, ema200: senti.ema200, rsi14: senti.rsi14,
        atr14: senti.atr14, zAtr: senti.zAtr, lastClose: senti.last,
        spreadBps: spreadBpsFixed
      },
      gates: { rrOK, trendOK, rsiOK },
      budgets: {
        dayKey: state.dayKey,
        riskUsedUsd: +state.riskUsedUsd.toFixed(2),
        maxTrades: MAX_TRADES_PER_DAY,
        tradesAccepted: state.tradesAccepted,
        tradesRejected: state.tradesRejected
      },
      version: VERSION,
      ts: Date.now()
    };

    // --- Accounting / State Update + Decision Log ---
    if (accept) {
      state.tradesAccepted++;
      state.riskUsedUsd += tradeRiskUsd;
      logAccept({ symbol, side, entry, sl: slR, tp: tpR, rr: payload.order.rr });

      // === PAPER SIMULATION ===
      const trade = {
        id, side, symbol, entry, sl: slR, tp: tpR, qty,
        notional: qty * entry,
        tsOpen: Date.now()
      };
      state.paperWallet.openTrades.push(trade);
      console.log(`[PAPER] Opened ${side.toUpperCase()} ${symbol} @${entry} | SL ${slR} TP ${tpR}`);

      try { tg?.tradeAccepted?.(payload.order, payload.indicators); } catch {}
    } else {
      state.tradesRejected++;
      for (const r of payload.reasonsRejected) {
        state.rejectReasons.set(r, (state.rejectReasons.get(r) || 0) + 1);
      }
      logReject(`Decision=${payload.decision}`, { symbol, side });
      try { tg?.tradeRejected?.(payload.order, payload.reasonsRejected); } catch {}
    }

    // Puffer füllen
    pushDecision({
      ts: payload.ts,
      side, symbol,
      entry, sl: slR, tp: tpR, rr: payload.order.rr,
      accept, reasons: payload.reasonsRejected,
      spreadBps: spreadBpsFixed,
      zAtr: senti.zAtr
    });

    // Menschlich lesbares Einzeilen-Log
    if (LOG_DECISIONS) {
      const tag = accept ? "ACCEPT ✅" : "REJECT ❌";
      const reasonTxt = reasons.length ? ` | ${reasons.join(",")}` : "";
      console.log(
        `[ACT] ${side.toUpperCase()} ${symbol} @${entry} | SL ${slR} TP ${tpR} | RR=${payload.order.rr} | ` +
        `spread=${spreadBpsFixed}bp zATR=${senti.zAtr?.toFixed?.(2) ?? 'na'} | ${tag}${reasonTxt}`
      );
    }

    return res.json(payload);
  } catch (err) {
    console.error("[WEBHOOK] error", err.response?.data || err.message || err);
    return res
      .status(500)
      .json({ ok: false, error: err.response?.data || err.message, version: VERSION });
  }
});


// Global error handler (ganz am Ende platzieren!)
router.use((err, req, res, next) => {
  console.error("[GLOBAL ERROR]", err?.stack || err?.message || err);
  res.status(500).json({ ok: false, error: err?.message || "internal_error" });
});


// ===================== EXPORTS =====================
module.exports = {
  router,
  // Optional: für Tests/Monitoring exportieren
  fetchCandles,
  fetchBookTicker,
  fetchSymbolFilters,
};
