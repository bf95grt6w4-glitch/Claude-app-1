// Ad-segment detection for podcast episodes.
//
// Strategy:
//   1. If the feed publishes a transcript (Podcasting 2.0 <podcast:transcript>,
//      SRT/VTT/JSON), fetch and parse it into timed cues.
//   2. With ANTHROPIC_API_KEY set, ask Claude to classify ad reads / sponsor
//      breaks from the timed transcript (structured output, exact timestamps).
//   3. Without a key, fall back to a keyword heuristic over the same cues.
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------- transcripts

function tsToSeconds(ts) {
  // "HH:MM:SS,mmm" | "HH:MM:SS.mmm" | "MM:SS.mmm"
  const m = ts.trim().match(/^(?:(\d+):)?(\d+):(\d+)[.,](\d+)$/);
  if (!m) return null;
  const [, h = '0', min, s, ms] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(`0.${ms}`);
}

export function parseSrtOrVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeLineIdx].split('-->');
    const start = tsToSeconds(startRaw);
    const end = tsToSeconds(endRaw?.trim().split(/\s+/)[0] ?? '');
    if (start == null || end == null) continue;
    const body = lines
      .slice(timeLineIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

export function parseJsonTranscript(text) {
  const data = JSON.parse(text);
  const segments = data.segments ?? data;
  if (!Array.isArray(segments)) return [];
  return segments
    .map((s) => ({
      start: Number(s.startTime ?? s.start),
      end: Number(s.endTime ?? s.end ?? (s.startTime ?? s.start)),
      text: String(s.body ?? s.text ?? '').trim(),
    }))
    .filter((c) => Number.isFinite(c.start) && c.text);
}

export async function fetchTranscriptCues(url, mimeType = '') {
  const res = await fetch(url, { headers: { 'User-Agent': 'AdBarrier/0.1' } });
  if (!res.ok) throw new Error(`transcript fetch returned ${res.status}`);
  const text = await res.text();
  const type = mimeType || res.headers.get('content-type') || '';
  if (type.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    return parseJsonTranscript(text);
  }
  return parseSrtOrVtt(text);
}

// ----------------------------------------------------------------- heuristics

const AD_PATTERNS = [
  /\bsponsored?\s+by\b/i,
  /\bbrought to you by\b/i,
  /\bthis episode is supported by\b/i,
  /\bpromo\s*code\b/i,
  /\buse (the )?code\b/i,
  /\bat checkout\b/i,
  /\bfree trial\b/i,
  /\bpercent off\b|\b\d+% off\b/i,
  /\bterms (and conditions )?apply\b/i,
  /\bvisit \S+\.(com|org|net|io|co)\b/i,
  /\bgo to \S+\.(com|org|net|io|co)\b/i,
  /\bslash\s+[a-z0-9]+\b.*\b(discount|deal|offer|code)\b/i,
  /\bad(vertisement)? break\b/i,
  /\bback to the (show|episode)\b/i,
  /\bword from our sponsors?\b/i,
  /\btoday'?s sponsor\b/i,
  /\bsign up (today|now)\b/i,
  /\blimited time offer\b/i,
];

function cueScore(text) {
  let score = 0;
  for (const re of AD_PATTERNS) if (re.test(text)) score += 1;
  return score;
}

// Merge ad-scored cues that sit close together into contiguous segments.
export function heuristicDetect(cues, { mergeGap = 30, pad = 4, minLen = 8 } = {}) {
  const hits = cues.filter((c) => cueScore(c.text) > 0);
  const segments = [];
  for (const cue of hits) {
    const last = segments[segments.length - 1];
    if (last && cue.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, cue.end);
      last.hits += 1;
    } else {
      segments.push({ start: cue.start, end: cue.end, hits: 1 });
    }
  }
  return segments
    .map((s) => ({
      start: Math.max(0, s.start - pad),
      end: s.end + pad,
      label: 'Sponsor read (heuristic)',
      source: 'heuristic',
      confidence: Math.min(0.9, 0.4 + s.hits * 0.15),
    }))
    .filter((s) => s.end - s.start >= minLen);
}

// -------------------------------------------------------------------- Claude

const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'Ad segment start, in seconds' },
          end: { type: 'number', description: 'Ad segment end, in seconds' },
          label: { type: 'string', description: 'Short description, e.g. the sponsor name' },
          confidence: { type: 'number', description: '0..1 confidence this is an ad' },
        },
        required: ['start', 'end', 'label', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
};

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function hasClaude() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function claudeDetect(cues) {
  const client = new Anthropic();
  const transcript = cues
    .map((c) => `[${fmt(c.start)}-${fmt(c.end)}] ${c.text}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system:
      'You identify advertising segments in podcast transcripts so a player can skip them. ' +
      'Ads include: pre/mid/post-roll sponsor reads, host-read promotions with promo codes or ' +
      'vanity URLs, dynamically inserted commercials, and cross-promotion for unrelated products. ' +
      'Do NOT flag the show discussing advertising as a topic, or promotion of the show itself ' +
      '(its own Patreon, merch, or next episode). Return precise second-based timestamps that ' +
      'cover the full ad break, including the lead-in ("a quick word from our sponsors") and the ' +
      'lead-out ("back to the show"). Merge back-to-back ads into one segment.',
    messages: [
      {
        role: 'user',
        content:
          'Timestamped podcast transcript (each line is [start-end] in m:ss):\n\n' + transcript,
      },
    ],
    output_config: { format: { type: 'json_schema', schema: SEGMENT_SCHEMA } },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this transcript');
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '{"segments":[]}';
  const { segments } = JSON.parse(text);
  return segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ ...s, source: 'claude' }));
}

// ------------------------------------------------------------------ top level

export async function detectSegments(transcriptUrl, mimeType) {
  const cues = await fetchTranscriptCues(transcriptUrl, mimeType);
  if (!cues.length) throw new Error('Transcript was empty or unparseable');
  if (hasClaude()) {
    try {
      return { method: 'claude', segments: await claudeDetect(cues) };
    } catch (err) {
      console.error('Claude detection failed, using heuristic:', err.message);
      return { method: 'heuristic', segments: heuristicDetect(cues), fallbackError: err.message };
    }
  }
  return { method: 'heuristic', segments: heuristicDetect(cues) };
}
