// Spotify "Ad Shield": OAuth connect, then a 2s polling loop that watches the
// user's playback. Spotify does not allow skipping its own ads, so the barrier
// mutes the player the moment an ad starts and restores the previous volume
// when real audio resumes (the same approach tools like EZBlocker use).
import { db, save } from './store.js';

const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
].join(' ');

const POLL_MS = 2000;

export const status = {
  configured: Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
  connected: Boolean(db.spotify.tokens),
  monitoring: false,
  adActive: false,
  muted: false,
  volumeBeforeAd: null,
  nowPlaying: null, // { type, title, artist, device }
  lastError: null,
  adsBlocked: db.spotify.events.filter((e) => e.type === 'ad_start').length,
};

function clientId() { return process.env.SPOTIFY_CLIENT_ID; }
function clientSecret() { return process.env.SPOTIFY_CLIENT_SECRET; }
function redirectUri(baseUrl) { return `${baseUrl}/api/spotify/callback`; }

function logEvent(type, detail = '') {
  db.spotify.events.unshift({ type, detail, at: new Date().toISOString() });
  db.spotify.events = db.spotify.events.slice(0, 100);
  save();
}

export function getAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    scope: SCOPES,
    redirect_uri: redirectUri(baseUrl),
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64'),
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Spotify token endpoint returned ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function handleCallback(code, baseUrl) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(baseUrl),
  });
  db.spotify.tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  save();
  status.connected = true;
  status.lastError = null;
  logEvent('connected', 'Spotify account linked');
  startMonitor();
}

export function disconnect() {
  db.spotify.tokens = null;
  save();
  status.connected = false;
  status.monitoring = false;
  status.adActive = false;
  status.muted = false;
  status.nowPlaying = null;
  logEvent('disconnected', 'Spotify account unlinked');
}

async function accessToken() {
  const t = db.spotify.tokens;
  if (!t) throw new Error('Not connected to Spotify');
  if (Date.now() < t.expiresAt) return t.accessToken;
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
  t.accessToken = data.access_token;
  if (data.refresh_token) t.refreshToken = data.refresh_token;
  t.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  save();
  return t.accessToken;
}

async function api(method, path) {
  const token = await accessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  return res;
}

async function setVolume(percent) {
  const res = await api('PUT', `/me/player/volume?volume_percent=${percent}`);
  // 403 = volume control not available on this device/account tier. Report it
  // so the UI can tell the user detection still works even if muting doesn't.
  if (res.status === 403) throw new Error('volume-forbidden');
  if (!res.ok && res.status !== 204) throw new Error(`volume returned ${res.status}`);
}

async function onAdStarted(player) {
  status.adActive = true;
  status.adsBlocked += 1;
  status.volumeBeforeAd = player?.device?.volume_percent ?? null;
  logEvent('ad_start', 'Ad break detected');
  try {
    await setVolume(0);
    status.muted = true;
    logEvent('muted', 'Player muted for the ad break');
  } catch (err) {
    status.muted = false;
    logEvent(
      'mute_failed',
      err.message === 'volume-forbidden'
        ? 'Spotify refused volume control on this device/account (ad still detected)'
        : `Could not mute: ${err.message}`,
    );
  }
}

async function onAdEnded() {
  status.adActive = false;
  logEvent('ad_end', 'Ad break over');
  if (status.muted) {
    const restoreTo = status.volumeBeforeAd ?? 70;
    try {
      await setVolume(restoreTo);
      logEvent('unmuted', `Volume restored to ${restoreTo}%`);
    } catch (err) {
      logEvent('unmute_failed', `Could not restore volume: ${err.message}`);
    }
    status.muted = false;
  }
  status.volumeBeforeAd = null;
}

async function tick() {
  if (!db.spotify.tokens) return;
  try {
    // The player endpoint includes device info (for volume); fall back to the
    // currently-playing shape when nothing extra is needed.
    const res = await api('GET', '/me/player?additional_types=track,episode');
    if (res.status === 204) {
      status.nowPlaying = null;
      if (status.adActive) await onAdEnded();
      return;
    }
    if (res.status === 401) {
      db.spotify.tokens = null;
      save();
      status.connected = false;
      status.lastError = 'Spotify session expired — reconnect.';
      return;
    }
    if (!res.ok) throw new Error(`player endpoint returned ${res.status}`);
    const player = await res.json();

    const isAd = player.currently_playing_type === 'ad';
    const item = player.item;
    status.nowPlaying = {
      type: player.currently_playing_type,
      title: isAd ? 'Advertisement' : item?.name ?? 'Unknown',
      artist: isAd
        ? ''
        : item?.artists?.map((a) => a.name).join(', ') || item?.show?.name || '',
      device: player.device?.name ?? '',
      isPlaying: player.is_playing,
    };
    status.lastError = null;

    if (isAd && !status.adActive) await onAdStarted(player);
    else if (!isAd && status.adActive) await onAdEnded();
  } catch (err) {
    status.lastError = err.message;
  }
}

let interval = null;
export function startMonitor() {
  if (interval || !db.spotify.tokens) return;
  status.monitoring = true;
  interval = setInterval(tick, POLL_MS);
  tick();
}

export function getEvents() {
  return db.spotify.events;
}

// Resume monitoring on server start if tokens were persisted.
if (db.spotify.tokens) startMonitor();
