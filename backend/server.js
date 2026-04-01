require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { rateLimit } = require('express-rate-limit');
const OpenAI  = require('openai');

// ── Startup guard ─────────────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is not set');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
// Set ALLOWED_ORIGINS env var (comma-separated) to restrict in production.
// Leave unset to allow all origins (fine for a mobile-app backend).
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : '*';
app.use(cors({ origin: allowedOrigins }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));

// ── Rate limiting: 30 requests / min / IP ────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use(limiter);

// ── OpenAI client (key stays server-side) ────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT =
  'You are a knowledgeable and compassionate Islamic scholar. ' +
  'When a user shares something they are struggling with, find the single most ' +
  'relevant and comforting Quran verse to help them. ' +
  'Respond ONLY with a valid JSON object — no markdown, no extra text — in exactly this format: ' +
  '{"surah_name":"Al-Baqarah","surah_number":2,"ayah_number":286,' +
  '"arabic":"لَا يُكَلِّفُ ٱللَّهُ نَفْسًا إِلَّا وُسْعَهَا",' +
  '"transliteration":"Lā yukallifu llāhu nafsan illā wus\'ahā",' +
  '"english":"Allah does not burden a soul beyond that it can bear.",' +
  '"context":"This verse is relevant because..."}';

const REQUIRED_FIELDS = [
  'surah_name', 'surah_number', 'ayah_number',
  'arabic', 'transliteration', 'english', 'context',
];

// ── POST /chat ────────────────────────────────────────────────────────────────
// Body: { prompt: string }   (1–500 chars)
// Response: verse JSON object
//
// curl example:
//   curl -X POST http://localhost:3001/chat \
//        -H 'Content-Type: application/json' \
//        -d '{"prompt":"I am feeling overwhelmed with stress at work"}'
app.post('/chat', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt must be a non-empty string.' });
  }
  const trimmed = prompt.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    return res.status(400).json({ error: 'prompt must be between 1 and 500 characters.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: trimmed },
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    });

    const verse = JSON.parse(completion.choices[0].message.content);

    for (const field of REQUIRED_FIELDS) {
      if (!(field in verse)) {
        return res.status(502).json({ error: 'Unexpected response from AI service.' });
      }
    }

    return res.json(verse);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'AI service rate limit reached. Please try again shortly.' });
    }
    return res.status(502).json({ error: 'Failed to retrieve a verse. Please try again.' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ── Bind to 0.0.0.0 so Railway/Docker can route traffic in ───────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Quran Companion backend listening on 0.0.0.0:${PORT}`);
});
