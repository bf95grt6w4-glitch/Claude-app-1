import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, save } from './store.js';
import * as spotify from './spotify.js';
import * as podcasts from './podcasts.js';
import { detectSegments, hasClaude } from './adDetect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const oauthStates = new Set();

// ------------------------------------------------------------------- general

app.get('/api/status', (req, res) => {
  res.json({
    spotify: { ...spotify.status },
    claude: hasClaude(),
    baseUrl: BASE_URL,
  });
});

// ------------------------------------------------------------------- spotify

app.get('/api/spotify/login', (req, res) => {
  if (!spotify.status.configured) {
    res.status(400).send('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first (see README).');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.add(state);
  res.redirect(spotify.getAuthUrl(BASE_URL, state));
});

app.get('/api/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?spotify=denied');
  if (!state || !oauthStates.delete(state)) return res.status(400).send('Bad OAuth state');
  try {
    await spotify.handleCallback(String(code), BASE_URL);
    res.redirect('/?spotify=connected');
  } catch (err) {
    console.error('Spotify callback failed:', err);
    res.status(500).send(`Spotify connect failed: ${err.message}`);
  }
});

app.post('/api/spotify/disconnect', (req, res) => {
  spotify.disconnect();
  res.json({ ok: true });
});

app.get('/api/spotify/events', (req, res) => {
  res.json(spotify.getEvents());
});

// ------------------------------------------------------------------ podcasts

app.get('/api/podcasts', (req, res) => {
  res.json(
    db.podcasts.map(({ episodes, ...meta }) => ({ ...meta, episodeCount: episodes.length })),
  );
});

app.post('/api/podcasts', async (req, res) => {
  const feedUrl = String(req.body?.feedUrl ?? '').trim();
  if (!/^https?:\/\//i.test(feedUrl)) {
    return res.status(400).json({ error: 'feedUrl must be an http(s) URL' });
  }
  try {
    const podcast = await podcasts.addOrRefreshFeed(feedUrl);
    res.json(podcast);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/podcasts/:id', (req, res) => {
  const podcast = db.podcasts.find((p) => p.id === req.params.id);
  if (!podcast) return res.status(404).json({ error: 'Podcast not found' });
  res.json(podcast);
});

app.delete('/api/podcasts/:id', (req, res) => {
  podcasts.removeFeed(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- ad segments

app.get('/api/episodes/:guid/segments', (req, res) => {
  res.json(db.segments[req.params.guid] ?? { segments: [] });
});

app.put('/api/episodes/:guid/segments', (req, res) => {
  const segments = (req.body?.segments ?? [])
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      label: String(s.label ?? 'Ad'),
      source: String(s.source ?? 'manual'),
      confidence: Number(s.confidence ?? 1),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  db.segments[req.params.guid] = { segments, updatedAt: new Date().toISOString() };
  save();
  res.json(db.segments[req.params.guid]);
});

app.post('/api/episodes/:guid/detect', async (req, res) => {
  const found = podcasts.findEpisode(req.params.guid);
  if (!found) return res.status(404).json({ error: 'Episode not found' });
  const { episode } = found;
  if (!episode.transcriptUrl) {
    return res.status(400).json({
      error:
        'This feed publishes no transcript for the episode, so automatic detection is unavailable. ' +
        'Mark ads manually with the "mark ad" buttons — they are remembered for next time.',
    });
  }
  try {
    const result = await detectSegments(episode.transcriptUrl, episode.transcriptType);
    db.segments[req.params.guid] = {
      segments: result.segments,
      updatedAt: new Date().toISOString(),
    };
    save();
    res.json({ method: result.method, ...db.segments[req.params.guid] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// -------------------------------------------------------------- audio proxy

app.get('/api/stream', async (req, res) => {
  const url = String(req.query.url ?? '');
  if (!podcasts.isKnownAudioUrl(url)) {
    return res.status(403).json({ error: 'URL is not a known episode enclosure' });
  }
  try {
    await podcasts.proxyAudio(url, req, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AdBarrier running at ${BASE_URL}`);
  console.log(`  Spotify configured: ${spotify.status.configured}`);
  console.log(`  Claude detection:   ${hasClaude() ? 'enabled' : 'disabled (heuristic mode)'}`);
});
