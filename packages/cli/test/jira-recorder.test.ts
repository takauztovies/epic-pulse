import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrub } from '../../../scripts/jira-scrub.mjs';

interface Scrubbed {
  readonly key: string;
  readonly fields: {
    readonly summary: string;
    readonly assignee: unknown;
    readonly description: { readonly content: readonly { readonly content: readonly { readonly attrs: { readonly text: string } }[] }[] };
  };
}

// A Jira recording is committed to a public repository, so it carries nothing
// about the person behind the demo account.
test('a recording keeps what the product reads and loses who the demo account is', () => {
  const issue = {
    key: 'EPD-4',
    self: 'https://demo.atlassian.net/rest/api/3/issue/10004',
    fields: {
      summary: 'Profile form',
      assignee: { displayName: 'Ana Example', emailAddress: 'ana@example.com', accountId: '5b10ac8d82e05b22cc7d4ef5', avatarUrls: { '48x48': 'https://x/a.png' }, active: true, timeZone: 'Europe/Bratislava' },
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: '5b10ac8d82e05b22cc7d4ef5', text: '@Ana Example' } }, { type: 'text', text: ' please look' }] }] },
    },
  };
  const text = JSON.stringify(scrub(issue));
  const out = JSON.parse(text) as Scrubbed;
  assert.deepEqual(out.fields.assignee, { displayName: 'Ana Example' });
  assert.equal(out.fields.description.content[0]?.content[0]?.attrs.text, '@Ana Example');
  for (const personal of ['ana@example.com', '5b10ac8d82e05b22cc7d4ef5', 'avatar', 'a.png', 'Bratislava', 'rest/api']) assert.equal(text.includes(personal), false, personal);
  assert.deepEqual([out.key, out.fields.summary], ['EPD-4', 'Profile form']);
});
