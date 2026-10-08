import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { COMMAND, CONFIG_SECTION, OVERVIEW_ID, VIEW_ID } from '../src/ids.js';
import { DEFAULT_REFRESH_SECONDS, MAX_REFRESH_SECONDS, MIN_REFRESH_SECONDS } from '../src/settings.js';

// The manifest and the code name the same commands, view and settings in two
// places. These checks keep them one: a renamed command must not leave a
// click, a menu entry or a setting that leads nowhere.
const ManifestSchema = z.object({
  name: z.string(),
  publisher: z.string(),
  icon: z.string(),
  main: z.string(),
  engines: z.object({ vscode: z.string() }),
  activationEvents: z.array(z.string()),
  contributes: z.object({
    commands: z.array(z.object({ command: z.string() })),
    views: z.record(z.string(), z.array(z.object({ id: z.string() }))),
    menus: z.record(z.string(), z.array(z.object({ command: z.string() }))),
    configuration: z.object({ properties: z.record(z.string(), z.object({ default: z.unknown(), minimum: z.number().optional(), maximum: z.number().optional() })) }),
  }),
});

const manifest = ManifestSchema.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

test('the extension is takauztovies.epic-pulse, loaded from the bundle the build writes', () => {
  assert.deepEqual([manifest.publisher, manifest.name, manifest.main], ['takauztovies', 'epic-pulse', './dist/extension.cjs']);
  assert.equal(manifest.engines.vscode, '^1.90.0');
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
});

// The Marketplace wants a PNG of at least 128 x 128. scripts/icon.sh draws it.
test('the icon is the 128 x 128 PNG that scripts/icon.sh draws', () => {
  assert.equal(manifest.icon, 'images/icon.png');
  const png = readFileSync(new URL(`../${manifest.icon}`, import.meta.url));
  assert.deepEqual([png.subarray(0, 8).toString('hex'), png.readUInt32BE(16), png.readUInt32BE(20)], ['89504e470d0a1a0a', 128, 128]);
});

test('every command the code runs is contributed, and every menu entry names one', () => {
  const contributed = manifest.contributes.commands.map((entry) => entry.command).sort();
  // A copy, so the assertion does not narrow `contributed` to the literal ids.
  assert.deepEqual([...contributed], Object.values(COMMAND).sort());
  const menuCommands = Object.values(manifest.contributes.menus).flat().map((entry) => entry.command);
  for (const command of menuCommands) assert.ok(contributed.includes(command), command);
  assert.deepEqual(Object.values(manifest.contributes.views).flat().map((view) => view.id), [OVERVIEW_ID, VIEW_ID]);
});

test('the settings the code reads are the ones contributed, with the same default and bounds', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.deepEqual(Object.keys(properties).sort(), [`${CONFIG_SECTION}.refreshSeconds`, `${CONFIG_SECTION}.statusBar.enabled`]);
  const refresh = properties[`${CONFIG_SECTION}.refreshSeconds`];
  assert.deepEqual([refresh?.default, refresh?.minimum, refresh?.maximum], [DEFAULT_REFRESH_SECONDS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS]);
  assert.equal(properties[`${CONFIG_SECTION}.statusBar.enabled`]?.default, true);
});
