const express = require('express');
const crypto = require('crypto');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const TV_SECRET = process.env.TV_SECRET || ''; // in Render -> Environment Variables

// Roh-Body für Signaturprüfung puffern
function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));
app.use(morgan('tiny'));

// Optionale Signaturprüfung (TradingView Webhook Header)
function verifySignature(req) {
  if (!TV_SECRET) return true; // Secret nicht gesetzt -> keine Prüfung
  const sig =
    req.get('X-TRADINGVIEW-SIGNATURE') ||
    req.get('X-Signature') ||
    '';
  if (!sig || !req.rawBody) return false;

  const expected = crypto
    .createHmac('sha256', TV_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

app.get('/', (_req, res) => res.send('TV webhook up'));
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ ok: false, error: 'bad signature' });
  }

  // Hier kommt dein Handling rein (z.B. Order weiterleiten)
  console.log('Alert payload:', req.body);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});
