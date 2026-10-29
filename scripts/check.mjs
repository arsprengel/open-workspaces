// Static checks that run in CI: manifest sanity, referenced files exist, locale keys are complete.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const EXT = resolve(import.meta.dirname, '..', 'extension');
const errors = [];
const fail = (msg) => errors.push(msg);

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));

// Files referenced by the manifest
const referenced = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.action?.default_popup,
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  manifest.background?.service_worker,
].filter(Boolean);
for (const file of referenced) if (!existsSync(join(EXT, file))) fail(`manifest references missing file: ${file}`);

// Locales
const localesDir = join(EXT, '_locales');
const locales = Object.fromEntries(readdirSync(localesDir).map((l) => [l, JSON.parse(readFileSync(join(localesDir, l, 'messages.json'), 'utf8'))]));
const base = locales[manifest.default_locale];
if (!base) fail(`default_locale "${manifest.default_locale}" has no messages.json`);

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const sources = walk(join(EXT, 'src')).filter((f) => f.endsWith('.js') && !f.includes('vendor'));
const used = new Set();
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/getMessage\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
}
for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
['tabs', 'resources', 'notes', 'tasks'].forEach((k) => used.add(k)); // t(view) in settings

for (const key of used) if (base && !base[key]) fail(`missing key in ${manifest.default_locale}: ${key}`);
for (const [locale, messages] of Object.entries(locales)) {
  for (const key of Object.keys(base ?? {})) if (!messages[key]) fail(`missing key in ${locale}: ${key}`);
  for (const key of Object.keys(messages)) if (!base?.[key]) fail(`extra key in ${locale} (not in ${manifest.default_locale}): ${key}`);
}
const unused = Object.keys(base ?? {}).filter((k) => !used.has(k));

// Relative imports resolve
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = resolve(file, '..', m[1]);
    if (!existsSync(target)) fail(`${relative(EXT, file)} imports missing ${m[1]}`);
  }
}

if (unused.length) console.log(`note: ${unused.length} unused locale keys: ${unused.join(', ')}`);
if (errors.length) {
  console.error(errors.map((e) => `✖ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✔ manifest, ${referenced.length} referenced files, ${Object.keys(locales).length} locales (${Object.keys(base).length} keys), ${sources.length} source files`);
