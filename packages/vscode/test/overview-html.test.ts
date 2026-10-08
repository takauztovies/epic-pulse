import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, overviewHtml } from '../src/overview-html.js';
import { modelOf } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, SESSION_A } from './registry-helpers.js';

async function demoEpics(t: Parameters<typeof makeRegistry>[0]) {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], pins: [demo(8)], snapshot: demoSnapshot(now - 1000) }, now);
  return (await modelOf([repo], now)).epics;
}

test('every epic card shows its bar, its percent and all five statuses, zeros included', async (t) => {
  const html = overviewHtml(await demoEpics(t), 'n0nce');
  assert.match(html, /<progress class="" max="100" value="20"><\/progress>/);
  assert.match(html, /<span class="pct">20%<\/span>/);
  assert.match(html, /Todo <b>1<\/b>.*In progress <b>2<\/b>.*In review <b>1<\/b>.*Done <b>1<\/b>.*Dropped <b>1<\/b>/s);
  const checklist = html.slice(html.indexOf('#8 '));
  assert.match(checklist, /Todo <b>2<\/b>.*In progress <b>0<\/b>.*In review <b>0<\/b>.*Done <b>2<\/b>.*Dropped <b>1<\/b>/s);
});

test('a finished epic gets the full (green) bar, and the card names its session', async (t) => {
  const [first] = await demoEpics(t);
  const done = overviewHtml([{ ...first!, percent: 100 }], 'n0nce');
  assert.match(done, /<progress class="full" max="100" value="100">/);
  assert.match(done, /Session: 0f8e7c1a/);
});

test('GitHub text is escaped, and the page allows only its own nonce-marked style and script', async (t) => {
  const [first] = await demoEpics(t);
  const html = overviewHtml([{ ...first!, title: '<img src=x onerror=alert(1)> & "q"' }], 'abc123');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&#60;img src=x onerror=alert\(1\)&#62; &#38; &#34;q&#34;/);
  assert.match(html, /content="default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123'"/);
  assert.doesNotMatch(html, /style="/);
  assert.equal(escapeHtml(`<>&"'`), '&#60;&#62;&#38;&#34;&#39;');
});

test('with no epic the page says so instead of staying blank', () => {
  assert.match(overviewHtml([], 'n'), /No epic to show/);
});
