# 🛡️ AdBarrier

AdBarrier sits between you and your audio apps, identifies ads, and gets them out of the way
automatically:

- **Spotify Ad Shield** — connects to your Spotify account, watches playback in real time, and
  the instant an ad break starts it **mutes the player**, restoring your previous volume when the
  music returns. (Spotify's own ads cannot be skipped or fast-forwarded by any client, so muting
  is the strongest barrier possible.)
- **Podcast Ad Skipper** — a built-in podcast player that **skips ad segments automatically**
  while an episode plays. Ad segments come from three sources, in order of preference:
  1. **Claude transcript analysis** — if the feed publishes an episode transcript
     (Podcasting 2.0 `<podcast:transcript>`, SRT/VTT/JSON) and an `ANTHROPIC_API_KEY` is set,
     Claude classifies sponsor reads and inserted ads with precise timestamps.
  2. **Keyword heuristics** — without an API key, a pattern matcher finds sponsor-read tells
     ("brought to you by", "use promo code…", "back to the show") in the transcript.
  3. **Manual marking** — two taps while listening ("ad start" / "ad end") save a segment
     forever; it's skipped on every future listen of that episode.

## Quick start

```bash
npm install
cp .env.example .env   # fill in what you want to enable (everything is optional)
npm start              # → http://127.0.0.1:8000
```

The podcast player works out of the box with zero configuration — paste any podcast RSS feed URL.

### Enabling the Spotify Ad Shield

1. Create an app at <https://developer.spotify.com/dashboard>.
2. Add `http://127.0.0.1:8000/api/spotify/callback` as a Redirect URI.
3. Put the client ID/secret in `.env`, restart, and click **Connect Spotify** in the UI.

The shield polls your playback every 2 seconds. When `currently_playing_type` becomes `ad`, it
sets the player volume to 0 via the Spotify Web API and restores it when the ad break ends.
Volume control requires an active device that supports it (desktop app, web player); if Spotify
refuses volume control, the ad is still detected and surfaced in the UI.

### Enabling Claude ad detection

Set `ANTHROPIC_API_KEY` in `.env`. When you press **🔎 Detect ads** on a playing episode, the
server fetches the episode transcript, sends the timed cues to Claude (`claude-opus-4-8` with
structured output), and stores the returned ad segments. Detection results are cached per
episode, so each transcript is analyzed once.

## How the pieces fit

```
┌──────────────┐   OAuth + polling    ┌─────────────────┐
│ Spotify API  │◄────────────────────►│                 │
└──────────────┘   mute / restore     │                 │      ┌───────────┐
                                      │  AdBarrier      │◄────►│  Web UI   │
┌──────────────┐   RSS + transcripts  │  (Express)      │      │ (player)  │
│ Podcast CDNs │◄────────────────────►│                 │      └───────────┘
└──────────────┘   range-proxy audio  └────────┬────────┘
                                               │ transcript cues
                                      ┌────────▼────────┐
                                      │ Claude API      │
                                      │ (ad classifier) │
                                      └─────────────────┘
```

- `server/spotify.js` — OAuth flow, token refresh, 2s playback monitor, mute/unmute logic.
- `server/podcasts.js` — RSS parsing (`fast-xml-parser`), episode catalog, range-aware audio
  proxy (restricted to known episode URLs).
- `server/adDetect.js` — SRT/VTT/JSON transcript parsing, keyword heuristics, Claude
  classification with a JSON-schema-constrained response.
- `server/store.js` — single-file JSON persistence (`data/db.json`).
- `public/` — vanilla-JS UI: Spotify status panel, podcast browser, and the auto-skipping player.

## Tests

```bash
npm test
```

Covers transcript parsing (SRT, VTT, JSON) and the heuristic segment detector.

## Notes & limitations

- **Personal use.** Muting Spotify ads may conflict with Spotify's Terms of Use (ad-supported
  tiers exist to fund the free service); this project is an educational/personal tool, and the
  friction-free answer is Spotify Premium. Use at your own discretion.
- Spotify ads cannot be skipped, only muted — that's an API/platform restriction, not a missing
  feature.
- Automatic podcast detection needs a transcript in the feed. Feeds without transcripts still get
  manual marking, which persists per-episode.
- The audio proxy only relays URLs that appear as enclosures in feeds you've added.
