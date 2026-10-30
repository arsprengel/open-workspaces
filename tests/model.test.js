import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImport, buildExport, cleanImage, emptyState, isExcluded, isHomeUrl, isNewTabUrl, isWindowFixture, keepAliveMatches,
  makeWorkspace, matchWindows, nearestGroupColor, normalizeState, overlapScore, pairParked, parseExclusions, pinSuggestionFor, realTabCount,
  recognizeParked, search,
  serializeTab, suggestedSite,
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

const HOME = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/home/home.html';

test('isHomeUrl recognises the pinned home tab of the extension', () => {
  assert.equal(isHomeUrl(HOME), true);
  assert.equal(isHomeUrl(`${HOME}?x=1`), true);
  for (const url of ['', undefined, 'https://mail.google.com/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/dashboard/dashboard.html']) {
    assert.equal(isHomeUrl(url), false, url);
  }
});

test('window fixtures: the home tab always, pinned tabs only when they are kept across workspaces', () => {
  const home = { url: HOME, pinned: true };
  const gmail = { url: 'https://mail.google.com/', pinned: true };
  const page = { url: 'https://example.com/', pinned: false };
  assert.equal(isWindowFixture(home, false), true);
  assert.equal(isWindowFixture(gmail, true), true);
  assert.equal(isWindowFixture(gmail, false), false);
  assert.equal(isWindowFixture(page, true), false);
  assert.equal(isWindowFixture({ url: '', pendingUrl: HOME }, false), true, 'pending URL counts');
});

test('saved tabs never keep the home tab', () => {
  const ws = makeWorkspace({ tabs: [{ url: HOME, pinned: true }, { url: 'https://a.com' }] });
  assert.deepEqual(ws.tabs.map((t) => t.url), ['https://a.com']);
  assert.equal(realTabCount(ws), 1);
});

test('workspace images: only small data:image URLs survive', () => {
  const png = `data:image/png;base64,${'A'.repeat(100)}`;
  assert.equal(cleanImage(png), png);
  assert.equal(cleanImage('https://evil.example/x.png'), '');
  assert.equal(cleanImage('data:text/html;base64,AAAA'), '');
  assert.equal(cleanImage(`data:image/png;base64,${'A'.repeat(400_000)}`), '');
  assert.equal(cleanImage(42), '');
  assert.equal(makeWorkspace({ name: 'A' }).image, '');
  assert.equal(normalizeState({ workspaces: { x: { id: 'x', image: png } } }).workspaces.x.image, png);
});

test('new settings default on: home tab and pinned tabs kept across workspaces', () => {
  const s = normalizeState({}).settings;
  assert.equal(s.homeTab, true);
  assert.equal(s.keepPinned, true);
});

test('suggestedSite knows the always-on sites and nothing else', () => {
  const cases = {
    'https://mail.google.com/mail/u/0/#inbox': 'gmail',
    'https://calendar.google.com/calendar/u/0/r': 'calendar',
    'https://chat.google.com/': 'googlechat',
    'https://outlook.office.com/mail/': 'outlook',
    'https://outlook.live.com/calendar/0/view/month': 'outlook',
    'https://outlook.office365.com/mail/inbox': 'outlook',
    'https://mail.proton.me/u/0/inbox': 'protonmail',
    'https://mail.yahoo.com/d/folders/1': 'yahoomail',
    'https://web.whatsapp.com/': 'whatsapp',
    'https://web.telegram.org/a/': 'telegram',
    'https://app.slack.com/client/T0/C0': 'slack',
    'https://teams.microsoft.com/v2/': 'teams',
    'https://teams.live.com/v2/': 'teams',
    'https://discord.com/channels/@me': 'discord',
    'https://open.spotify.com/': 'spotify',
    'https://music.youtube.com/': 'youtubemusic',
  };
  for (const [url, id] of Object.entries(cases)) assert.equal(suggestedSite(url)?.id, id, url);
  for (const url of [
    'https://www.google.com/', 'https://discord.com/', 'https://www.youtube.com/watch?v=1', 'https://slack.com/',
    'https://mail.google.com.evil.example/', 'https://notmail.google.com/', 'chrome://newtab/', '', undefined,
  ]) assert.equal(suggestedSite(url), null, String(url));
  assert.equal(suggestedSite('https://mail.google.com/').name, 'Gmail');
});

test('pinSuggestionFor asks once, only for unpinned always-on sites when pinned tabs stay', () => {
  const settings = normalizeState({}).settings;
  const gmail = { id: 1, url: 'https://mail.google.com/mail/u/0/', pinned: false, incognito: false };
  const other = { id: 2, url: 'https://example.com/', pinned: false };
  const ask = (over = {}) => pinSuggestionFor({ tab: gmail, windowTabs: [gmail, other], settings, asked: {}, ...over });

  assert.equal(ask()?.id, 'gmail');
  assert.equal(ask({ tab: other, windowTabs: [other] }), null, 'not an always-on site');
  assert.equal(ask({ tab: { ...gmail, pinned: true } }), null, 'already pinned');
  assert.equal(ask({ tab: { ...gmail, incognito: true } }), null, 'incognito');
  assert.equal(ask({ asked: { gmail: true } }), null, 'already asked this session');
  assert.equal(ask({ settings: { ...settings, pinMuted: { gmail: true } } }), null, 'muted for this site');
  assert.equal(ask({ settings: { ...settings, pinMuted: { gmail: false } } })?.id, 'gmail', 'unmuted again');
  assert.equal(ask({ settings: { ...settings, pinSuggestions: false } }), null, 'suggestions off');
  assert.equal(ask({ settings: { ...settings, keepPinned: false } }), null, 'pinning would not keep it across workspaces');
  const pinnedGmail = { id: 3, url: 'https://mail.google.com/mail/u/1/', pinned: true };
  assert.equal(ask({ windowTabs: [gmail, pinnedGmail] }), null, 'the site is already pinned in this window');
});

test('pin suggestions default on with nothing muted', () => {
  const s = normalizeState({}).settings;
  assert.equal(s.pinSuggestions, true);
  assert.deepEqual(s.pinMuted, {});
  assert.deepEqual(normalizeState({ settings: { pinMuted: { slack: true } } }).settings.pinMuted, { slack: true });
});

test('serializeTab records the keep-alive mark only when set, and saved tabs keep it', () => {
  const tab = { url: 'https://a.com', title: 'A', pinned: false, active: false, groupId: -1 };
  assert.equal('keepAlive' in serializeTab(tab), false);
  assert.equal(serializeTab(tab, false).keepAlive, undefined);
  assert.equal(serializeTab(tab, true).keepAlive, true);
  const state = normalizeState({ workspaces: { x: { id: 'x', tabs: [{ url: 'https://a.com', keepAlive: true }, { url: 'https://b.com', keepAlive: 'yes' }, { url: 'https://c.com' }] } } });
  assert.deepEqual(state.workspaces.x.tabs.map((t) => t.keepAlive), [true, undefined, undefined]);
});

test('parked tabs of other workspaces are window fixtures, not part of the window\'s workspace', () => {
  const tab = { id: 5, url: 'https://a.com', pinned: false };
  assert.equal(isWindowFixture(tab, true), false);
  assert.equal(isWindowFixture(tab, true, { 5: { wsId: 'x', order: 0 } }), true);
  assert.equal(isWindowFixture(tab, true, { 6: { wsId: 'x', order: 0 } }), false);
});

test('nearestGroupColor maps workspace colors onto the browser group palette', () => {
  assert.equal(nearestGroupColor('#ef4444'), 'red');
  assert.equal(nearestGroupColor('#22c55e'), 'green');
  assert.equal(nearestGroupColor('#3b82f6'), 'blue');
  assert.equal(nearestGroupColor('#8b5cf6'), 'purple');
  assert.equal(nearestGroupColor('#f97316'), 'orange');
  assert.equal(nearestGroupColor('nope'), 'grey');
});

test('recognizeParked finds parked groups by recorded title and URLs', () => {
  const records = { a: { title: '🚀 Alpha', urls: ['https://chat.example/', 'https://music.example/x'] }, b: { title: 'Beta', urls: ['https://b.example/'] } };
  const groups = [
    { title: 'Work stuff', tabs: [{ id: 1, url: 'https://chat.example/' }] },
    { title: '🚀 Alpha', tabs: [{ id: 2, url: 'https://chat.example/#top' }, { id: 3, url: 'https://music.example/x' }] },
    { title: 'Beta', tabs: [{ id: 4, url: 'https://other.example/' }] },
    { title: '🚀 Alpha', tabs: [{ id: 5, url: 'https://chat.example/' }] },
  ];
  assert.deepEqual(recognizeParked(groups, records), [{ wsId: 'a', tabIds: [2, 3] }]);
  assert.deepEqual(recognizeParked([{ title: 'Beta', tabs: [] }], records), []);
});

test('pairParked gives the n-th kept-alive saved tab the n-th parked tab', () => {
  const saved = [{ url: 'a' }, { url: 'b', keepAlive: true }, { url: 'c' }, { url: 'd', keepAlive: true }];
  const parked = [{ tabId: 9, order: 3 }, { tabId: 7, order: 1 }];
  const { byIndex, leftover } = pairParked(saved, parked);
  assert.deepEqual([...byIndex], [[1, 7], [3, 9]]);
  assert.deepEqual(leftover, []);

  const fewer = pairParked([{ url: 'b', keepAlive: true }], parked);
  assert.deepEqual([...fewer.byIndex], [[0, 7]]);
  assert.deepEqual(fewer.leftover, [9], 'parked tabs with no saved entry left are still handed back');
  assert.deepEqual([...pairParked(saved, []).byIndex], []);
});

test('keepAliveMatches finds the live tabs behind kept-alive saved tabs', () => {
  const live = [{ id: 1, url: 'https://a.com/' }, { id: 2, url: 'https://b.com/#x' }, { id: 3, url: 'https://b.com/' }, { id: 4, pendingUrl: 'https://c.com/', url: '' }];
  const saved = [{ url: 'https://a.com/' }, { url: 'https://b.com/', keepAlive: true }, { url: 'https://b.com/', keepAlive: true }, { url: 'https://c.com/', keepAlive: true }, { url: 'https://gone.com/', keepAlive: true }];
  assert.deepEqual(keepAliveMatches(live, saved), [2, 3, 4]);
  assert.deepEqual(keepAliveMatches(live, [{ url: 'https://a.com/' }]), []);
});

test('switching workspaces shows the Open Workspaces page by default', () => {
  assert.equal(normalizeState({}).settings.homeOnSwitch, true);
  assert.equal(normalizeState({ settings: { homeOnSwitch: false } }).settings.homeOnSwitch, false);
});
