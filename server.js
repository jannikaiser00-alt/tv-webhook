// server.js - minimal Express webhook
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json()); // parse application/json

// Optionaler Secret-Check (setze TV_SECRET bei Render → Environment)
const SECRET = process.env.TV_SECRET || '';

function authOk(req) {
  const q = req.query.token;
  const h = req.get('x-tv-secret') || req.get('x-webhook-token');
  const b = req.body && (req.body.token || req.body.secret);
  return SECRET ? (q === SECRET || h === SECRET || b === SECRET) : true;
}

app
