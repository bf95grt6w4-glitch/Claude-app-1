// Tiny JSON-file persistence layer. Everything the app remembers lives in
// data/db.json: Spotify tokens + event log, podcast subscriptions, and
// per-episode ad segments.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const defaults = {
  spotify: { tokens: null, events: [] },
  podcasts: [],
  // keyed by episode guid -> { segments: [{start, end, label, source, confidence}], updatedAt }
  segments: {},
};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { ...structuredClone(defaults), ...parsed };
  } catch {
    return structuredClone(defaults);
  }
}

export const db = load();

let timer = null;
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    } catch (err) {
      console.error('Failed to persist db.json:', err.message);
    }
  }, 250);
}
