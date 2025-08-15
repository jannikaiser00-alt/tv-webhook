// server.js
"use strict";

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===================== VERSION =====================
const VERSION = (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || "local";
console.log(`[BOOT] tv-webhook ${VERSION} starting…`);

// ===================== ENV / KONFIG =====================
const TV_SECRET        = (process.env.TV_SECRET || "").trim();        // muss zu Pine "webhookSecret" passen
const MIN_RR           = parseFloat(process.env.MIN_RR || "3.0");      // Mindest-CRV 1:3
const ATR_MULT         = parseFloat(process.env.ATR_MULT || "1.2");    // Fallback für SL-Ermittlung
const MARKET_INTERVAL  = process.env.MARKET_INTERVAL || "15m";         // 1m/5m/15m/1h...
const EXCHANGE_BASE    = process.env.EXCHANGE_BASE || "https://api.binance.com";
const SENTI_MODE       = (process.env.SENTI_MODE || "strict").toLowerCase();     // 'strict'|'lenient'
const AUTO_ADJUST_TP   = (process.env.AUTO_ADJUST_TP || "true").toLowerCase() === "true";
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
};

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

// ===================== UTILS =====================
function roundToStep(v, step) {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}
function ceilToStep(v, step) {
  if (!step || step <= 0) return v;
  return Math.ceil(v / step) * step;
}
function floorToStep(v, step) {
  if (!step || step <= 0) return v;
  return Math.floor(v / step) * step;
}
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

// ===================== EXCHANGE DATA (Binance public) =====================
async function fetchCandles(symbol = "SOLUSDT", interval = "15m", limit = 400) {
  const url = `${EXCHANGE_BASE}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  const highs  = data.map(d => parseFloat(d[2]));
  const lows   = data.map(d => parseFloat(d[3]));
  const closes = data.map(d => parseFloat(d[4]));
  return { highs, lows, closes, lastClose: closes[closes.length - 1] };
}

async function fetchBookTicker(symbol = "SOLUSDT") {
  const url = `${EXCHANGE_BASE}/api/v3/ticker/bookTicker?symbol=${symbol.toUpperCase()}`;
  const { data } = await axios.get(url, { timeout: 7000 });
  return { bid: parseFloat(data.bidPrice), ask: parseFloat(data.askPrice) };
}

const exchInfoCache = new Map(); // symbol -> { tickSize, stepSize, minNotional, ts }

async function fetchSymbolFilters(symbol = "SOLUSDT") {
  const cached = exchInfoCache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.ts < 60_000) return cached; // 60s Cache

  const url = `${EXCHANGE_BASE}/api/v3/exchangeInfo?symbol=${symbol.toUpperCase()}`;
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const s = data.symbols && data.symbols[0];
    if (!s || !s.filters) throw new Error("exchangeInfo: symbol not found");

    let tickSize = FALLBACK_PRICE_TICK;
    let stepSize = FALLBACK_LOT_STEP;
    let minNotional = FALLBACK_MIN_NOTIONAL;

    for (const f of s.filters) {
      if (f.filterType === "PRICE_FILTER") tickSize = parseFloat(f.tickSize);
      if (f.filterType === "LOT_SIZE")     stepSize = parseFloat(f.stepSize);
      if (f.filterType === "MIN_NOTIONAL") minNotional = parseFloat(f.minNotional);
    }
    const out = { tickSize, stepSize, minNotional, ts: now };
    exchInfoCache.set(symbol, out);
    return out;
  } catch {
    const out = { tickSize: FALLBACK_PRICE_TICK, stepSize: FALLBACK_LOT_STEP, minNotional: FALLBACK_MIN_NOTIONAL, ts: now };
    exchInfoCache.set(symbol, out);
    return out;
  }
}

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

// ===================== SAFETY / HOUSEKEEPING =====================
function stale(tsMs) {
  if (!tsMs || !isFinite(tsMs)) return false;
  const age = Date.now() - Number(tsMs);
  return age > ACCEPT_OLD_MS;
}

function seenBefore(id, ttl = DUP_TTL_MS) {
  if (!id) return false;
  const now = Date.now();
  // Cleanup alte IDs
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

// ===================== HEALTH / DEBUG =====================
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: VERSION });
});

app.get("/debug/env", (req, res) => {
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

app.get("/debug/state", (req, res) => {
  rotateDayIfNeeded();
  res.json({
    dayKey: state.dayKey,
    riskUsedUsd: state.riskUsedUsd,
    tradesAccepted: state.tradesAccepted,
    tradesRejected: state.tradesRejected,
    cachedSymbols: Array.from(exchInfoCache.keys())
  });
});

// Letzte Entscheidungen (für die volle Kontrolle)
app.get("/debug/decisions", (req, res) => {
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || "100", 10)));
  const symbol = (req.query.symbol || "").toUpperCase();
  const rows = state.decisions
    .filter(d => !symbol || d.symbol === symbol)
    .slice(-limit);
  res.json({ count: rows.length, rows });
});

// Tages‑Summary (Anzahl, Gründe)
app.get("/debug/summary", (req, res) => {
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

// ===================== WEBHOOK CORE =====================
app.post("/webhook", async (req, res) => {
  try {
    rotateDayIfNeeded();

    // --- Secret prüfen ---
    const authHeader = req.get("authorization") || "";
    const fromBearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim() : "";
    const clientSecret = (
      (req.body && req.body.secret) ||
      req.get("x-tv-secret") ||
      fromBearer || ""
    ).toString().trim();

    if (!TV_SECRET)   return res.status(500).json({ ok: false, error: "server_secret_missing" });
    if (!clientSecret) return res.status(401).json({ ok: false, error: "client_secret_missing" });
    if (clientSecret !== TV_SECRET) return res.status(401).json({ ok: false, error: "secret_mismatch" });

    // --- Payload lesen ---
    const p = req.body || {};
    const side   = (p.side || "").toLowerCase();     // buy/sell
    const symbol = (p.symbol || "SOLUSDT").toUpperCase();
    const px     = Number(p.px);
    let   sl     = p.sl != null ? Number(p.sl) : null;
    let   tp     = p.tp != null ? Number(p.tp) : null;
    const qtyUsd = p.qtyUsd != null ? Number(p.qtyUsd) : null;
    const id     = (p.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`).toString();
    const ts     = Number(p.ts || Date.now());

    if (!(side === "buy" || side === "sell"))
      return res.status(400).json({ ok: false, error: "bad_side" });
    if (!isFinite(px))
      return res.status(400).json({ ok: false, error: "bad_px" });

    // --- Idempotenz & Stale ---
    if (seenBefore(id)) {
      return res.json({ ok: true, decision: "DUPLICATE_DROPPED", id });
    }
    if (stale(ts)) {
      state.tradesRejected++;
      const reason = "stale_alert";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({ ok: true, decision: "REJECT", reason, ageMs: Date.now() - ts });
    }

    // --- Marktdaten & Indikatoren ---
    const [candles, book] = await Promise.all([
      fetchCandles(symbol, MARKET_INTERVAL, CANDLE_LIMIT),
      fetchBookTicker(symbol).catch(() => ({ bid: px * 0.999, ask: px * 1.001 })) // Fallback
    ]);

    const senti = sentimentScore(candles);
    if (senti.atr14 == null || senti.ema50 == null || senti.ema200 == null || senti.rsi14 == null) {
      return res.status(500).json({ ok: false, error: "indicator_insufficient_data" });
    }

    // --- Spread Gate ---
    const spread = Math.max(0, (book.ask - book.bid));
    const mid    = (book.ask + book.bid) / 2;
    const spreadBps = mid > 0 ? (spread / mid) * 1e4 : 9999;
    if (spreadBps > SPREAD_MAX_BPS) {
      state.tradesRejected++;
      const reason = "SpreadTooWide";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({ ok: true, decision: "REJECT", reason, spreadBps, limitBps: SPREAD_MAX_BPS });
    }

    // --- Volatility Brake (ATR Z‑Score) ---
    if (senti.zAtr != null && senti.zAtr > Z_ATR_MAX) {
      state.tradesRejected++;
      const reason = "VolSpike";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({ ok: true, decision: "REJECT", reason, zAtr: senti.zAtr, zAtrMax: Z_ATR_MAX });
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

    // --- SL/TP Sanity (richtige Seite) ---
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

    // --- RR prüfen/erzwingen ---
    let rrNow = rr(px, sl, tp, side);
    let rrAdjusted = false;
    if (rrNow == null) return res.status(400).json({ ok: false, error: "rr_compute_failed" });
    if (rrNow < MIN_RR && AUTO_ADJUST_TP) {
      const risk = side === "buy" ? (px - sl) : (sl - px);
      tp = side === "buy" ? (px + MIN_RR * risk) : (px - MIN_RR * risk);
      rrNow = rr(px, sl, tp, side);
      rrAdjusted = true;
    }

    const trendOK   = (side === "buy") ? senti.upTrend  : senti.downTrend;
    const rsiOK     = (side === "buy") ? senti.rsiOKLong: senti.rsiOKShort;
    const rrOK      = rrNow >= MIN_RR;

    const passStrict  = rrOK && trendOK && rsiOK;
    const passLenient = rrOK && (trendOK || rsiOK);
    const acceptSenti = SENTI_MODE === "strict" ? passStrict : passLenient;

    // --- Symbol-Throttle ---
    if (symbolThrottled(symbol)) {
      state.tradesRejected++;
      const reason = "SymbolThrottle";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({ ok: true, decision: "REJECT", reason, throttleMs: MIN_MS_BETWEEN_TRADES });
    }

    // --- Tageslimits (Budget & Trades) ---
    if (state.tradesAccepted >= MAX_TRADES_PER_DAY) {
      state.tradesRejected++;
      const reason = "MaxTradesDay";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({ ok: true, decision: "REJECT", reason, max: MAX_TRADES_PER_DAY });
    }

    // --- Sizing (Exchange-Filter) ---
    const filters = await fetchSymbolFilters(symbol);
    const notionalTarget = Math.max(Number.isFinite(qtyUsd) ? qtyUsd : filters.minNotional, filters.minNotional);
    let qty = notionalTarget / px;

    if (filters.stepSize > 0) qty = floorToStep(qty, filters.stepSize);
    if (qty <= 0) {
      state.tradesRejected++;
      const reason = "QtyTooSmall";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({ ok: true, decision: "REJECT", reason, step: filters.stepSize, minNotional: filters.minNotional });
    }

    let notional = qty * px;
    if (notional < filters.minNotional) {
      qty = ceilToStep(filters.minNotional / px, filters.stepSize || 0);
      notional = qty * px;
    }

    const entry = filters.tickSize > 0 ? roundToStep(px, filters.tickSize) : px;
    const slR   = filters.tickSize > 0 ? roundToStep(sl, filters.tickSize) : sl;
    const tpR   = filters.tickSize > 0 ? roundToStep(tp, filters.tickSize) : tp;

    const riskPerUnit = side === "buy" ? (entry - slR) : (slR - entry);
    const tradeRiskUsd = Math.max(0, riskPerUnit) * qty;

    if (DAILY_RISK_BUDGET_USD > 0 && (state.riskUsedUsd + tradeRiskUsd) > DAILY_RISK_BUDGET_USD) {
      state.tradesRejected++;
      const reason = "DailyRiskBudget";
      state.rejectReasons.set(reason, (state.rejectReasons.get(reason) || 0) + 1);
      return res.json({
        ok: true, decision: "REJECT", reason,
        riskUsedUsd: state.riskUsedUsd, tradeRiskUsd, limit: DAILY_RISK_BUDGET_USD
      });
    }

    // --- Finale Entscheidung ---
    const accept = acceptSenti;
    const reasons = [];
    if (!rrOK)      reasons.push(`RR<${MIN_RR}`);
    if (!trendOK)   reasons.push("TrendMismatch");
    if (!rsiOK)     reasons.push("RSIContextBad");

    const payload = {
      ok: true,
      decision: accept ? "ACCEPT" : "REJECT",
      wouldPlace: accept,                    // <<< wichtigste Flag zum Verstehen
      action: accept ? "PLACE_ORDER" : "SKIP",
      mode: SENTI_MODE,
      reasonsRejected: accept ? [] : reasons,
      order: {
        id, side, symbol,
        entry, sl: slR, tp: tpR, rr: +rrNow.toFixed(3), rrAdjusted,
        qty, notional: +(qty * entry).toFixed(4),
        riskUsd: +tradeRiskUsd.toFixed(4)
      },
      indicators: {
        ema50: senti.ema50, ema200: senti.ema200, rsi14: senti.rsi14,
        atr14: senti.atr14, zAtr: senti.zAtr, lastClose: senti.last,
        spreadBps: +spreadBps.toFixed(3)
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
    } else {
      state.tradesRejected++;
      for (const r of payload.reasonsRejected) {
        state.rejectReasons.set(r, (state.rejectReasons.get(r) || 0) + 1);
      }
    }

    // Puffer füllen
    pushDecision({
      ts: payload.ts,
      side, symbol,
      entry, sl: slR, tp: tpR, rr: payload.order.rr,
      accept, reasons: payload.reasonsRejected,
      spreadBps: payload.indicators.spreadBps,
      zAtr: payload.indicators.zAtr
    });

    // Menschlich lesbares Einzeilen‑Log
    if (LOG_DECISIONS) {
      const tag = accept ? "ACCEPT ✅" : "REJECT ❌";
      const reasonTxt = payload.reasonsRejected.length ? ` | ${payload.reasonsRejected.join(",")}` : "";
      console.log(
        `[ACT] ${side.toUpperCase()} ${symbol} @${entry} | SL ${slR} TP ${tpR} | RR=${payload.order.rr} | spread=${payload.indicators.spreadBps}bp zATR=${payload.indicators.zAtr?.toFixed?.(2) ?? 'na'} | ${tag}${reasonTxt}`
      );
    }

    // >>> HIER später: nur bei accept echte Order an Exchange senden
    // if (accept) await placeOrderAndBracketsBitunix({ ... }).catch(e => payload.exchangeError = e.message || String(e));

    return res.json(payload);

  } catch (err) {
    console.error("[WEBHOOK] error", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.response?.data || err.message, version: VERSION });
  }
});

// ===================== START =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} (v=${VERSION})`));

/* ===================== BITUNIX-ADAPTER (Skizze) =====================

async function placeOrderAndBracketsBitunix({ side, symbol, qty, entry, sl, tp, postOnly = true }) {
  // TODO:
  // 1) Signatur / API-Key/Secret über ENV laden (BITUNIX_KEY, BITUNIX_SECRET)
  // 2) Maker-Only Limit-Order (postOnly) für Entry
  // 3) OCO/Brackets: Stop-Loss + Take-Profit reduce-only verknüpfen
  // 4) Retries mit Exponential Backoff
  // 5) Idempotenz mit ClientOrderId = id (vom Alert)
  throw new Error("Bitunix adapter not implemented yet.");
}
*/
