import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrtOrVtt, parseJsonTranscript, heuristicDetect } from '../server/adDetect.js';

test('parses SRT into timed cues', () => {
  const srt = `1
00:00:01,000 --> 00:00:04,500
Welcome back to the show.

2
00:00:04,500 --> 00:00:09,000
Today we talk about oceans.`;
  const cues = parseSrtOrVtt(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 4.5);
  assert.equal(cues[1].text, 'Today we talk about oceans.');
});

test('parses VTT (dot milliseconds, header, tags)', () => {
  const vtt = `WEBVTT

00:10.000 --> 00:12.000
<v Host>Hello there</v>`;
  const cues = parseSrtOrVtt(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 10);
  assert.equal(cues[0].text, 'Hello there');
});

test('parses Podcasting 2.0 JSON transcripts', () => {
  const json = JSON.stringify({
    segments: [
      { startTime: 0, endTime: 3, body: 'Intro music' },
      { startTime: 3, endTime: 8, body: 'Hello listeners' },
    ],
  });
  const cues = parseJsonTranscript(json);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].start, 3);
});

test('heuristic finds sponsor reads and merges adjacent cues', () => {
  const cues = [
    { start: 0, end: 30, text: 'Today we discuss deep sea creatures.' },
    { start: 60, end: 70, text: 'This episode is brought to you by MattressCo.' },
    { start: 70, end: 80, text: 'Use promo code OCEAN for 20% off at checkout.' },
    { start: 85, end: 95, text: 'Now back to the show.' },
    { start: 200, end: 230, text: 'The anglerfish uses a bioluminescent lure.' },
  ];
  const segments = heuristicDetect(cues);
  assert.equal(segments.length, 1);
  assert.ok(segments[0].start <= 60);
  assert.ok(segments[0].end >= 95);
  assert.equal(segments[0].source, 'heuristic');
});

test('heuristic ignores clean content', () => {
  const cues = [
    { start: 0, end: 30, text: 'The history of jazz begins in New Orleans.' },
    { start: 30, end: 60, text: 'Louis Armstrong changed everything.' },
  ];
  assert.equal(heuristicDetect(cues).length, 0);
});
