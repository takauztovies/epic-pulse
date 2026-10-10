import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentNote, DEFAULT_WARN_AT, limitWarning, readingFrom, resetText, warnAt, warningVariants } from '../src/limits.js';
import { claimNotice, readLimits, READING_FRESH_MS, writeLimits } from '../src/limits-store.js';
import { tempDir } from './repo-helpers.js';

// The shape Claude Code documents for the status-line payload's `rate_limits`:
// a used percentage and the reset time in epoch seconds, per window.
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const IN_2H10 = (NOW + (2 * 60 + 10) * 60_000) / 1000;
const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const payload = (fiveHour: number, sevenDay = 40) => ({ five_hour: { used_percentage: fiveHour, resets_at: IN_2H10 }, seven_day: { used_percentage: sevenDay, resets_at: IN_2H10 + 86400 * 3 } });

test('a reading comes from the documented payload, and none from a payload without limits', () => {
  assert.deepEqual(readingFrom(payload(91.4), NOW), { v: 1, at: NOW, fiveHour: { pct: 91.4, resetsAt: IN_2H10 * 1000 }, sevenDay: { pct: 40, resetsAt: (IN_2H10 + 86400 * 3) * 1000 } });
  for (const none of [undefined, null, {}, { five_hour: 'x' }, 'text', { seven_day: { used_percentage: 'high' } }]) assert.equal(readingFrom(none, NOW), undefined, JSON.stringify(none));
  assert.deepEqual(readingFrom({ seven_day: { used_percentage: 95 } }, NOW)?.sevenDay, { pct: 95, resetsAt: null }, 'a reset time may be missing');
});

test('it warns from the threshold on, about the fuller window that has not reset, in steps', () => {
  const at = (five: number, seven = 40) => limitWarning(readingFrom(payload(five, seven), NOW)!, DEFAULT_WARN_AT, NOW);
  assert.equal(at(89.9), undefined);
  assert.deepEqual([at(90)?.window, at(90)?.pct, at(90)?.band], ['5h', 90, 90]);
  assert.deepEqual([at(96.7)?.pct, at(96.7)?.band, at(99.2)?.band], [96, 95, 99]);
  assert.deepEqual([at(91, 97)?.window, at(91, 97)?.pct], ['week', 97], 'the fuller window');
  assert.equal(limitWarning(readingFrom(payload(95), NOW)!, DEFAULT_WARN_AT, IN_2H10 * 1000 + 1), undefined, 'a window that has reset says nothing');
});

test('the threshold is EPIC_PULSE_LIMIT_WARN, a whole percentage from 50 to 100, else 90', () => {
  assert.deepEqual(['80', '50', '100', '49', '101', '85.5', 'x', undefined].map((value) => warnAt({ EPIC_PULSE_LIMIT_WARN: value })), [80, 50, 100, 90, 90, 90, 90, 90]);
  assert.deepEqual([80, 94, 95].map((pct) => limitWarning(readingFrom(payload(pct), NOW)!, 80, NOW)?.band), [80, 80, 95]);
});

test('the status line and the agent are told in plain words, with when it resets', () => {
  const warning = limitWarning(readingFrom(payload(91), NOW)!, DEFAULT_WARN_AT, NOW)!;
  assert.deepEqual(warningVariants(warning, NOW), ['⚠ 91% 5h limit, resets in 2h10m · /compact', '⚠ 91% 5h limit · /compact', '⚠ 91%']);
  assert.match(agentNote(warning, NOW), /^epic-pulse: this Claude account is at 91% of the 5-hour usage limit \(resets in 2h10m\), shared by every session\. Wrap up: .+ do not start new subagents.+suggest \/compact/);
  assert.deepEqual([resetText(null, NOW), resetText(NOW + 30_000, NOW), resetText(NOW + 35 * 60_000, NOW), resetText(NOW + 3 * 86_400_000, NOW)], ['', 'resets in 1 min', 'resets in 35 min', 'resets in 3 days']);
});

test('the saved reading is used only while fresh, and a corrupt file is no reading', async (t) => {
  const cache = tempDir(t);
  await writeLimits(cache, readingFrom(payload(92), NOW)!);
  assert.equal((await readLimits(cache, NOW + READING_FRESH_MS))?.fiveHour?.pct, 92);
  assert.equal(await readLimits(cache, NOW + READING_FRESH_MS + 1), undefined, 'no status line rendered for ten minutes');
  assert.equal(await readLimits(tempDir(t), NOW), undefined);
});

// Once per step and per window period, per session: a note on every prompt would
// cost tokens on every turn and be ignored.
test('a session is told once per step, again at the next step, and again after the window resets', async (t) => {
  const cache = tempDir(t);
  const warning = (pct: number, resetsAt = IN_2H10 * 1000) => ({ ...limitWarning(readingFrom(payload(pct), NOW)!, DEFAULT_WARN_AT, NOW)!, resetsAt, now: NOW });
  assert.equal(await claimNotice(cache, SESSION, warning(91)), true);
  assert.equal(await claimNotice(cache, SESSION, warning(93)), false, 'same step');
  assert.equal(await claimNotice(cache, SESSION, warning(96)), true, 'next step');
  assert.equal(await claimNotice(cache, SESSION, warning(91)), false, 'a lower step is not news');
  assert.equal(await claimNotice(cache, SESSION, warning(91, IN_2H10 * 1000 + 5 * 3_600_000)), true, 'a new window');
  assert.equal(await claimNotice(cache, SESSION.replace('0f', '1f'), warning(91)), true, 'every session is told');
  assert.equal(await claimNotice(cache, '../../etc', warning(91)), false, 'not a session id');
});
