import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImport, buildExport, emptyState, isExcluded, isNewTabUrl, makeWorkspace, matchWindows,
  normalizeState, overlapScore, parseExclusions, search, serializeTab,
} from '../extension/src/shared/model.js';

test('isNewTabUrl recognises blank and new-tab pages', () => {
  for (const url of ['', undefined, 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page', 'edge://newtab', 'chrome-search://local-ntp/local-ntp.html']) {
    assert.equal(isNewTabUrl(url), true, url);
  }
  for (const url of ['https://example.com', 'chrome://settings', 'file:///C:/a.txt']) assert.equal(isNewTabUrl(url), false, url);
});

test('serializeTab keeps the pending URL and drops huge data: favicons', () => {
  const tab = serializeTab({ url: '', pendingUrl: 'https://a.com', title: 'A', favIconUrl: `data:${'x'.repeat(5000)}`, pinned: true, active: false, groupId: 7 });
  assert.deepEqual(tab, { url: 'https://a.com', title: 'A', favIconUrl: '', pinned: true, active: false, groupKey: '7' });
  assert.equal(serializeTab({ url: 'https://b.com', groupId: -1 }).groupKey, null);
});

test('normalizeState repairs broken input', () => {
  assert.deepEqual(normalizeState(null), emptyState());
  const ws = makeWorkspace({ name: 'A' });
  const state = normalizeState({
    order: ['missing', ws.id, ws.id],
    workspaces: { [ws.id]: { ...ws, tabs: [{ url: 'https://a.com' }, { nope: 1 }], sections: [] } },
    settings: { openMode: 'newWindow', suspend: { maxTabs: 10 }, bogus: true, theme: 42 },
  });
  assert.deepEqual(state.order, [ws.id]);
  assert.equal(state.workspaces[ws.id].tabs.length, 1);
  assert.equal(state.workspaces[ws.id].sections.length, 1, 'always at least one resource section');
  assert.equal(state.settings.openMode, 'newWindow');
  assert.equal(state.settings.suspend.maxTabs, 10);
  assert.equal(state.settings.suspend.mode, 'manual', 'nested defaults are kept');
  assert.equal(state.settings.theme, 'system', 'wrong types fall back to defaults');
  assert.equal('bogus' in state.settings, false);
});

test('workspaces missing from order are appended', () => {
  const a = makeWorkspace({ name: 'A' });
  const b = makeWorkspace({ name: 'B' });
  const state = normalizeState({ order: [b.id], workspaces: { [a.id]: a, [b.id]: b } });
  assert.deepEqual(state.order, [b.id, a.id]);
});

test('overlapScore ignores hashes and new tabs', () => {
  assert.equal(overlapScore(['https://a.com/#x', 'chrome://newtab/'], ['https://a.com/']), 1);
  assert.equal(overlapScore(['https://a.com', 'https://b.com'], ['https://a.com', 'https://c.com']), 0.5);
  assert.equal(overlapScore(['chrome://newtab/'], ['chrome://newtab/']), 0);
});

test('matchWindows pairs each window with its best workspace once', () => {
  const windows = [
    { id: 1, urls: ['https://a.com', 'https://b.com'] },
    { id: 2, urls: ['https://c.com', 'https://d.com', 'https://e.com'] },
    { id: 3, urls: ['https://zzz.com'] },
  ];
  const workspaces = [
    { id: 'A', urls: ['https://a.com', 'https://b.com'] },
    { id: 'C', urls: ['https://c.com', 'https://d.com'] },
    { id: 'A2', urls: ['https://a.com'] },
  ];
  const result = matchWindows(windows, workspaces);
  assert.equal(result.get(1), 'A');
  assert.equal(result.get(2), 'C');
  assert.equal(result.has(3), false);
});

test('exclusions match domains, subdomains and URL prefixes', () => {
  const rules = parseExclusions('example.com\n\n https://docs.site.io/keep \nwww.music.app');
  assert.equal(isExcluded('https://example.com/x', rules), true);
  assert.equal(isExcluded('https://mail.example.com/', rules), true);
  assert.equal(isExcluded('https://notexample.com/', rules), false);
  assert.equal(isExcluded('https://docs.site.io/keep/this', rules), true);
  assert.equal(isExcluded('https://docs.site.io/other', rules), false);
  assert.equal(isExcluded('https://music.app/', rules), true);
});

test('search finds workspaces, tabs and resources', () => {
  const ws = makeWorkspace({
    name: 'Client Acme',
    tabs: [{ url: 'https://acme.com/invoices', title: 'Invoices' }],
    sections: [{ id: 's', name: '', items: [{ id: 'i', url: 'https://figma.com/acme', title: 'Acme design' }] }],
  });
  const state = normalizeState({ order: [ws.id], workspaces: { [ws.id]: ws } });
  const types = search(state, 'acme').map((r) => r.type);
  assert.deepEqual(types.sort(), ['resource', 'tab', 'workspace']);
  assert.equal(search(state, 'acme invoices').length, 1);
  assert.equal(search(state, '   ').length, 0);
});

test('import merge adds copies with new ids, replace swaps everything', () => {
  const a = makeWorkspace({ name: 'A' });
  const current = normalizeState({ order: [a.id], workspaces: { [a.id]: a } });
  const file = buildExport(current);

  const merged = applyImport(current, file, 'merge');
  assert.equal(merged.order.length, 2);
  assert.notEqual(merged.order[1], a.id);
  assert.equal(merged.workspaces[merged.order[1]].name, 'A');
  assert.equal(current.order.length, 1, 'input state is not mutated');

  const b = makeWorkspace({ name: 'B' });
  const replaced = applyImport(current, { workspaces: { [b.id]: b }, order: [b.id] }, 'replace');
  assert.deepEqual(replaced.order, [b.id]);

  assert.throws(() => applyImport(current, { hello: 'world' }), /invalid-file/);
});
