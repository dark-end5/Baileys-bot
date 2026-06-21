// pair_mock.js - simple pairing backend (Express + in-memory codes)
// Use this for local testing. For production replace with a real backend.

const express = require('express');
const app = express();
app.use(express.json());

let mockCodes = {
  'ABC123': { success:true, peer:'Alice', connectUrl:'https://example.com/session/abc' },
  'XYZ999': { success:true, peer:'Bob' }
};

// Admin endpoint to create codes (protected by PAIR_ADMIN_KEY env)
app.post('/admin/create-code', (req, res) => {
  const key = process.env.PAIR_ADMIN_KEY || '';
  const auth = req.headers['x-api-key'] || req.query.api_key || req.body.api_key;
  if (!key) return res.status(403).json({ success:false, message:'Admin key not configured.' });
  if (auth !== key) return res.status(401).json({ success:false, message:'Invalid API key.' });
  const code = req.body.code || Math.random().toString(36).slice(2,8).toUpperCase();
  const peer = req.body.peer || 'unknown';
  mockCodes[code] = { success:true, peer, connectUrl:req.body.connectUrl || null };
  return res.json({ success:true, code, peer });
});

app.post('/verify', (req, res) => {
  const { code, phone } = req.body || {};
  if (!code) return res.status(400).json({ success:false, message:'Missing code' });
  const entry = mockCodes[code];
  if (!entry) return res.json({ success:false, message:'Invalid or expired code' });
  // optionally delete to make single-use
  delete mockCodes[code];
  return res.json({ ...entry, phone });
});

const PORT = process.env.MOCK_PORT || 4000;
app.listen(PORT, () => console.log(`Mock pairing service listening on ${PORT}`));
