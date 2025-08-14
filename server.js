// server.js
const express = require('express');
const app = express();

app.use(express.json());

// ---- Konfiguration / Secret laden (leerzeichen sicher entfernen)
const TV_SECRET = (process.env.TV_SECRET || '').trim();

// Healthcheck
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Debug-Endpunkt: zeigt ob das Secret auf dem Server vorhanden ist (ohne es preiszugeben)
app.get('/debug/env', (req, res) => {
  res.json({
    hasSecret: TV_SECRET.length > 0,
    secretLength: TV_SECRET.length,           // nur Länge, nicht den Wert!
    nodeEnv: process.env.NODE_ENV || null,
  });
});

// Webhook
app.post('/webhook', (req, res) => {
  // 1) clientSecret aus Body, Header X-TV-SECRET, oder "Authorization: Bearer <secret>"
  const authHeader = req.get('authorization') || '';
  const fromBearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  const clientSecret = (
      (req.body && req.body.secret) ||
      req.get('x-tv-secret') ||
      fromBearer ||
      ''
    ).toString().trim();

  // 2) Troubleshooting-Infos (ohne geheime Werte!) ins Log
  console.log('[WEBHOOK] incoming', {
    time: new Date().toISOString(),
    hasServerSecret: TV_SECRET.length > 0,
    clientSecretLen: clientSecret.length,
    headersSeen: {
      hasAuth: !!authHeader,
      hasXTV: !!req.get('x-tv-secret')
    }
  });

  // 3) hart & eindeutig antworten (hilft beim Testen)
  if (!TV_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'server_secret_missing',
      msg: 'Server: TV_SECRET ist NICHT gesetzt. Prüfe Render > Environment Variables.',
    });
  }

  if (!clientSecret) {
    return res.status(401).json({
      ok: false,
      error: 'client_secret_missing',
      msg: 'Erwarte Secret in body.secret ODER Header X-TV-SECRET ODER Authorization: Bearer <secret>',
    });
  }

  if (clientSecret !== TV_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'secret_mismatch',
      msg: 'Client-Secret stimmt nicht.',
      gotLen: clientSecret.length
    });
  }

  // 4) Alles ok -> payload verarbeiten (hier nur echo zurück)
  const payload = req.body || {};
  console.log('[WEBHOOK] accepted payload:', payload);

  res.json({ ok: true, received: payload });
});

// Server starten
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
