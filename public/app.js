/* AdBarrier frontend: Spotify status panel + podcast player with ad skipping. */

const $ = (id) => document.getElementById(id);
const fmt = (t) => {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/* ================================ Spotify ================================ */

async function refreshSpotify() {
  try {
    const { spotify, claude } = await api('/api/status');

    const claudePill = $('claude-pill');
    claudePill.textContent = claude ? 'Claude detection on' : 'heuristic detection';
    claudePill.className = 'pill ' + (claude ? 'on' : 'warn');

    const pill = $('spotify-pill');
    $('spotify-disconnected').hidden = spotify.connected;
    $('spotify-connected').hidden = !spotify.connected;
    $('spotify-config-hint').hidden = spotify.configured;

    if (!spotify.configured) {
      pill.textContent = 'not configured';
      pill.className = 'pill';
    } else if (!spotify.connected) {
      pill.textContent = 'disconnected';
      pill.className = 'pill';
    } else {
      pill.textContent = spotify.adActive ? 'AD — muted' : 'watching';
      pill.className = 'pill ' + (spotify.adActive ? 'warn' : 'on');
      $('np-ad-banner').hidden = !spotify.adActive;
      if (spotify.adActive && !spotify.muted) {
        $('np-ad-banner').textContent = '📣 AD DETECTED — muting unavailable on this device';
      } else {
        $('np-ad-banner').textContent = '🔇 AD DETECTED — muted';
      }
      const np = spotify.nowPlaying;
      $('np-title').textContent = np ? np.title : 'Nothing playing';
      $('np-sub').textContent = np
        ? [np.artist, np.device && `on ${np.device}`].filter(Boolean).join(' · ')
        : '';
      $('ads-blocked').textContent = spotify.adsBlocked;
    }
  } catch {
    /* server briefly unavailable; retry on next tick */
  }
}

async function refreshSpotifyEvents() {
  try {
    const events = await api('/api/spotify/events');
    $('spotify-events').innerHTML = events
      .map(
        (e) =>
          `<li><strong>${e.type.replace(/_/g, ' ')}</strong> — ${e.detail}
           <span style="float:right">${new Date(e.at).toLocaleTimeString()}</span></li>`,
      )
      .join('');
  } catch { /* ignore */ }
}

$('spotify-disconnect').addEventListener('click', async () => {
  await api('/api/spotify/disconnect', { method: 'POST' });
  refreshSpotify();
});

setInterval(refreshSpotify, 2000);
setInterval(refreshSpotifyEvents, 5000);
refreshSpotify();
refreshSpotifyEvents();

/* ================================ Podcasts =============================== */

let activePodcastId = null;

async function loadPodcasts() {
  const podcasts = await api('/api/podcasts');
  $('podcast-list').innerHTML = '';
  for (const p of podcasts) {
    const chip = document.createElement('div');
    chip.className = 'podcast-chip' + (p.id === activePodcastId ? ' active' : '');
    chip.innerHTML = `${p.image ? `<img src="${p.image}" alt="" onerror="this.replaceWith('🎙️')">` : '🎙️'}
      <span>${p.title}</span><span class="x" title="Remove">✕</span>`;
    chip.addEventListener('click', () => openPodcast(p.id));
    chip.querySelector('.x').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/podcasts/${p.id}`, { method: 'DELETE' });
      if (activePodcastId === p.id) {
        activePodcastId = null;
        $('episode-panel').hidden = true;
      }
      loadPodcasts();
    });
    $('podcast-list').appendChild(chip);
  }
}

async function openPodcast(id) {
  activePodcastId = id;
  const podcast = await api(`/api/podcasts/${id}`);
  $('episode-panel').hidden = false;
  $('episode-podcast-title').textContent = podcast.title;
  const list = $('episode-list');
  list.innerHTML = '';
  for (const ep of podcast.episodes) {
    const row = document.createElement('div');
    row.className = 'episode';
    const date = ep.pubDate ? new Date(ep.pubDate).toLocaleDateString() : '';
    row.innerHTML = `
      <div class="meta">
        <div class="title">${ep.title}</div>
        <div class="sub">
          <span>${date}</span>
          ${ep.duration ? `<span>${fmt(ep.duration)}</span>` : ''}
          <span class="badge ${ep.transcriptUrl ? '' : 'none'}">
            ${ep.transcriptUrl ? '📝 transcript' : 'no transcript'}
          </span>
          <span class="badge seg-badge" data-guid="${ep.guid}"></span>
        </div>
      </div>
      <button class="btn small">▶ Play</button>`;
    row.querySelector('button').addEventListener('click', () => playEpisode(podcast, ep));
    list.appendChild(row);
    // async: show whether saved ad segments exist
    api(`/api/episodes/${ep.guid}/segments`).then(({ segments }) => {
      const b = row.querySelector('.seg-badge');
      if (segments?.length) b.textContent = `🚫 ${segments.length} ad segment${segments.length > 1 ? 's' : ''}`;
    });
  }
  loadPodcasts();
}

$('add-feed').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('feed-error').hidden = true;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const podcast = await api('/api/podcasts', {
      method: 'POST',
      body: JSON.stringify({ feedUrl: $('feed-url').value }),
    });
    $('feed-url').value = '';
    await openPodcast(podcast.id);
  } catch (err) {
    $('feed-error').textContent = err.message;
    $('feed-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add podcast';
  }
});

/* ================================ Player ================================= */

const audio = $('audio');
const state = {
  episode: null,
  segments: [],
  pendingStart: null, // manual "ad start" mark awaiting an end
  lastSkipAt: 0,
};

function renderSegments() {
  const dur = audio.duration || state.episode?.duration || 0;
  const holder = $('timeline-ads');
  holder.innerHTML = '';
  if (!dur) return;
  for (const seg of state.segments) {
    const el = document.createElement('div');
    el.className = 'ad-seg';
    el.style.left = `${(seg.start / dur) * 100}%`;
    el.style.width = `${Math.max(0.4, ((seg.end - seg.start) / dur) * 100)}%`;
    el.title = `${seg.label} (${fmt(seg.start)}–${fmt(seg.end)})`;
    holder.appendChild(el);
  }
}

async function saveSegments() {
  const data = await api(`/api/episodes/${state.episode.guid}/segments`, {
    method: 'PUT',
    body: JSON.stringify({ segments: state.segments }),
  });
  state.segments = data.segments;
  renderSegments();
}

function toast(msg) {
  const t = $('skip-toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

async function playEpisode(podcast, ep) {
  state.episode = ep;
  state.pendingStart = null;
  $('player').hidden = false;
  $('player-title').textContent = `${podcast.title} — ${ep.title}`;
  $('mark-end').disabled = true;
  audio.src = `/api/stream?url=${encodeURIComponent(ep.audioUrl)}`;
  audio.play().catch(() => {});
  $('play-pause').textContent = '⏸';
  const { segments } = await api(`/api/episodes/${ep.guid}/segments`);
  state.segments = segments ?? [];
  renderSegments();
}

audio.addEventListener('timeupdate', () => {
  const dur = audio.duration || 0;
  $('time-cur').textContent = fmt(audio.currentTime);
  $('time-dur').textContent = fmt(dur);
  if (dur) $('timeline-progress').style.width = `${(audio.currentTime / dur) * 100}%`;

  if (!$('auto-skip').checked) return;
  const t = audio.currentTime;
  const seg = state.segments.find((s) => t >= s.start && t < s.end - 0.5);
  if (seg && Date.now() - state.lastSkipAt > 1500) {
    state.lastSkipAt = Date.now();
    audio.currentTime = seg.end;
    toast(`⏭ Skipped ${fmt(seg.end - seg.start)} of ads (${seg.label})`);
  }
});

audio.addEventListener('loadedmetadata', renderSegments);

$('play-pause').addEventListener('click', () => {
  if (audio.paused) {
    audio.play();
    $('play-pause').textContent = '⏸';
  } else {
    audio.pause();
    $('play-pause').textContent = '▶';
  }
});

$('timeline').addEventListener('click', (e) => {
  if (!audio.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
});

$('mark-start').addEventListener('click', () => {
  state.pendingStart = audio.currentTime;
  $('mark-end').disabled = false;
  toast(`⛳ Ad start marked at ${fmt(state.pendingStart)} — now mark the end`);
});

$('mark-end').addEventListener('click', async () => {
  if (state.pendingStart == null) return;
  const start = Math.min(state.pendingStart, audio.currentTime);
  const end = Math.max(state.pendingStart, audio.currentTime);
  if (end - start < 1) return toast('Segment too short — play past the ad, then mark the end.');
  state.segments.push({ start, end, label: 'Ad (marked by you)', source: 'manual', confidence: 1 });
  state.pendingStart = null;
  $('mark-end').disabled = true;
  await saveSegments();
  toast(`🚫 Ad segment saved (${fmt(start)}–${fmt(end)})`);
});

$('clear-segments').addEventListener('click', async () => {
  state.segments = [];
  await saveSegments();
  toast('Cleared all ad segments for this episode.');
});

$('detect-ads').addEventListener('click', async () => {
  if (!state.episode) return;
  const btn = $('detect-ads');
  btn.disabled = true;
  btn.textContent = '🔎 Detecting…';
  try {
    const data = await api(`/api/episodes/${state.episode.guid}/detect`, { method: 'POST' });
    state.segments = data.segments;
    renderSegments();
    toast(
      data.segments.length
        ? `Found ${data.segments.length} ad segment(s) via ${data.method === 'claude' ? 'Claude' : 'heuristics'}.`
        : 'No ads found in the transcript.',
    );
  } catch (err) {
    toast(`⚠️ ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔎 Detect ads';
  }
});

loadPodcasts();
