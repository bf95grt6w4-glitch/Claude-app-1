// Podcast subscriptions: RSS fetching/parsing and a range-aware audio proxy so
// the browser player can stream episodes without CORS issues.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { XMLParser } from 'fast-xml-parser';
import { db, save } from './store.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feeds mix namespaces (itunes:, podcast:); keep prefixes as-is.
  // Large feeds contain thousands of &amp;-style entities, which trips the
  // parser's expansion guard — decode the standard five ourselves instead.
  processEntities: false,
});

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);
}

function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

function text(x) {
  if (x == null) return '';
  const raw = typeof x === 'object' ? String(x['#text'] ?? '') : String(x);
  return decodeEntities(raw);
}

function parseDuration(d) {
  const s = text(d).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function parseFeed(xml, feedUrl) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('Not a valid RSS podcast feed');

  const episodes = asArray(channel.item)
    .map((item) => {
      const enclosure = asArray(item.enclosure)[0];
      const audioUrl = enclosure?.['@_url'] && decodeEntities(enclosure['@_url']);
      if (!audioUrl) return null;
      const transcript = asArray(item['podcast:transcript'])[0];
      const guidRaw = text(item.guid) || audioUrl;
      return {
        guid: crypto.createHash('sha1').update(guidRaw).digest('hex'),
        title: text(item.title) || 'Untitled episode',
        pubDate: text(item.pubDate),
        duration: parseDuration(item['itunes:duration']),
        audioUrl,
        transcriptUrl: transcript?.['@_url'] ? decodeEntities(transcript['@_url']) : null,
        transcriptType: transcript?.['@_type'] ?? null,
      };
    })
    .filter(Boolean);

  return {
    id: crypto.createHash('sha1').update(feedUrl).digest('hex').slice(0, 12),
    feedUrl,
    title: text(channel.title) || feedUrl,
    description: text(channel.description).slice(0, 500),
    image:
      (channel['itunes:image']?.['@_href'] && decodeEntities(channel['itunes:image']['@_href'])) ||
      text(channel.image?.url) ||
      null,
    episodes: episodes.slice(0, 50),
    refreshedAt: new Date().toISOString(),
  };
}

export async function addOrRefreshFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'AdBarrier/0.1 (podcast client)' },
  });
  if (!res.ok) throw new Error(`Feed fetch returned ${res.status}`);
  const podcast = parseFeed(await res.text(), feedUrl);
  const idx = db.podcasts.findIndex((p) => p.id === podcast.id);
  if (idx >= 0) db.podcasts[idx] = podcast;
  else db.podcasts.push(podcast);
  save();
  return podcast;
}

export function removeFeed(id) {
  const idx = db.podcasts.findIndex((p) => p.id === id);
  if (idx >= 0) {
    db.podcasts.splice(idx, 1);
    save();
  }
}

export function findEpisode(guid) {
  for (const p of db.podcasts) {
    const ep = p.episodes.find((e) => e.guid === guid);
    if (ep) return { podcast: p, episode: ep };
  }
  return null;
}

// Only proxy URLs we know about (episode audio) — keeps the proxy from being
// an open relay.
export function isKnownAudioUrl(url) {
  return db.podcasts.some((p) => p.episodes.some((e) => e.audioUrl === url));
}

export async function proxyAudio(url, req, res) {
  const headers = { 'User-Agent': 'AdBarrier/0.1 (podcast client)' };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(url, { headers });
  if (!upstream.ok && upstream.status !== 206) {
    res.status(502).json({ error: `Upstream returned ${upstream.status}` });
    return;
  }
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) res.setHeader('accept-ranges', 'bytes');
  Readable.fromWeb(upstream.body).pipe(res);
}
