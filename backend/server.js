require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const OpenAI = require('openai');

// ── Validate required env vars on startup ────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is not set in .env');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS — restrict to your app's origin in production ───────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : '*';

app.use(cors({ origin: allowedOrigins }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));

// ── Rate limiting: 30 requests per 15 min per IP ─────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api', limiter);

// ── OpenAI client (key never leaves this server) ──────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a knowledgeable and compassionate Islamic scholar.
When a user shares something they are struggling with, find the single most relevant and comforting Quran verse to help them.
Respond ONLY with a valid JSON object — no markdown, no extra text — in exactly this format:
{
  "surah_name": "Al-Baqarah",
  "surah_number": 2,
  "ayah_number": 286,
  "arabic": "لَا يُكَلِّفُ ٱللَّهُ نَفْسًا إِلَّا وُسْعَهَا",
  "transliteration": "Lā yukallifu llāhu nafsan illā wus'ahā",
  "english": "Allah does not burden a soul beyond that it can bear.",
  "context": "This verse is relevant because..."
}`;

// ── POST /api/verse ───────────────────────────────────────────────────────────
app.post('/api/verse', async (req, res) => {
  const { struggle } = req.body;

  // Input validation
  if (!struggle || typeof struggle !== 'string') {
    return res.status(400).json({ error: 'struggle must be a non-empty string.' });
  }
  const trimmed = struggle.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return res.status(400).json({ error: 'struggle must be between 1 and 500 characters.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0].message.content;
    const verse = JSON.parse(text);

    // Validate the response has all required fields
    const required = ['surah_name', 'surah_number', 'ayah_number', 'arabic', 'transliteration', 'english', 'context'];
    for (const field of required) {
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

app.listen(PORT, () => {
  console.log(`Quran Companion backend running on port ${PORT}`);
});
