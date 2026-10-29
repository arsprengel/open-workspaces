// End-to-end smoke test: launches a Chromium-based browser headless with the extension
// loaded in a throwaway profile, drives the real service worker through the dashboard page
// via the Chrome DevTools Protocol and checks the results.
//
// Usage: npm run smoke            (auto-detects Chromium/Helium/Chrome for Testing/Edge)
//        BROWSER=/path/to/chrome npm run smoke
//        HEADED=1 npm run smoke   (show the browser window)
//
// Note: Google Chrome (branded) 137+ ignores --load-extension. Use Chromium, Chrome for
// Testing, Helium, Brave, etc.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EXT = resolve(import.meta.dirname, '..', 'extension');

function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    join(local, 'imput', 'Helium', 'Application', 'chrome.exe'),
    join(local, 'Chromium', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Helium.app/Contents/MacOS/Helium',
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found. Set BROWSER=/path/to/chromium');
  return found;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && this.pending.has(data.id)) {
        const { res, rej } = this.pending.get(data.id);
        this.pending.delete(data.id);
        data.error ? rej(new Error(data.error.message)) : res(data.result);
      } else if (data.method) this.events.push(data);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  errors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
      .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.args?.map((a) => a.value ?? a.description).join(' '));
  }
  close() {
    this.ws.close();
  }
}

async function getJson(port, path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return res.json();
}

/** Runs inside the dashboard page (extension context). Returns a list of check results. */
async function scenario() {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: ok ? '' : JSON.stringify(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (action, payload = {}) => {
    const r = await chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
    if (!r?.ok) throw new Error(`${action}: ${r?.error}`);
    return r.result;
  };
  const state = async () => (await chrome.storage.local.get('state')).state;
  const winMap = async () => (await chrome.storage.session.get('windowMap')).windowMap ?? {};
  const urlsOf = async (windowId) => (await chrome.tabs.query({ windowId })).map((t) => t.pendingUrl || t.url);
  const waitFor = async (fn, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(150);
    }
    return false;
  };
  const U = ['https://example.com/?a', 'https://example.com/?b', 'https://example.com/?c'];

  // 1. Save a window as workspace A
  const win = await chrome.windows.create({ url: U, focused: false });
  await sleep(500);
  const { id: A } = await call('createWorkspace', { name: 'Alpha', icon: '🚀', fromWindowId: win.id });
  check('window bound to A', (await winMap())[win.id] === A);
  check('A snapshot has 3 tabs', await waitFor(async () => (await state()).workspaces[A].tabs.length === 3), (await state()).workspaces[A].tabs);

  // 2. Create B (closed) and switch the window to it
  const { id: B } = await call('createWorkspace', { name: 'Beta' });
  await call('openWorkspace', { id: B, windowId: win.id });
  const afterSwitch = await urlsOf(win.id);
  check('switch to empty B leaves one new tab', afterSwitch.length === 1 && !afterSwitch[0].startsWith('https'), afterSwitch);
  check('window bound to B', (await winMap())[win.id] === B);
  check('A kept its 3 tabs after switching away', (await state()).workspaces[A].tabs.length === 3);

  // 3. Changes in B are saved
  await chrome.tabs.create({ windowId: win.id, url: 'https://example.org/' });
  check('new tab saved into B', await waitFor(async () => (await state()).workspaces[B].tabs.some((t) => t.url.startsWith('https://example.org'))));

  // 4. Switch back to A: tabs restored, inactive ones lazily discarded
  await call('openWorkspace', { id: A, windowId: win.id });
  const restored = await chrome.tabs.query({ windowId: win.id });
  check('A restored with its 3 URLs', restored.map((t) => t.pendingUrl || t.url).join() === U.join(), restored.map((t) => t.url));
  check('inactive restored tabs get discarded', await waitFor(async () => (await chrome.tabs.query({ windowId: win.id })).filter((t) => !t.active).every((t) => t.discarded)));
  const disc = await chrome.tabs.query({ windowId: win.id });
  check('discarded tabs keep their URL', disc.every((t) => U.includes(t.url)), disc.map((t) => t.url));
  check('B kept example.org after switching away', (await state()).workspaces[B].tabs.some((t) => t.url.startsWith('https://example.org')));

  // 5. Close A: its window goes away, tabs stay saved
  await call('closeWorkspace', { id: A });
  await sleep(400);
  check('A window closed', !(await chrome.windows.getAll()).some((w) => w.id === win.id));
  check('A still has 3 saved tabs after close', (await state()).workspaces[A].tabs.length === 3, (await state()).workspaces[A].tabs);
  check('A unbound after close', !Object.values(await winMap()).includes(A));

  // 6. Re-open A from a window with unsaved tabs (this dashboard): must open a new window
  const self = await chrome.windows.getCurrent();
  const { windowId: aWin } = await call('openWorkspace', { id: A, windowId: self.id });
  check('A opened in a new window (unsaved window untouched)', aWin !== self.id && (await urlsOf(self.id)).length >= 1);
  check('A window has its tabs', (await urlsOf(aWin)).join() === U.join(), await urlsOf(aWin));

  // 7. Opening an already-open workspace focuses it instead of duplicating
  const again = await call('openWorkspace', { id: A, windowId: self.id });
  check('opening an open workspace reuses its window', again.windowId === aWin);

  // 8. Move a tab from A (open) to B (closed)
  const [first] = await chrome.tabs.query({ windowId: aWin, index: 0 });
  await call('moveTabs', { tabIds: [first.id], targetId: B });
  await sleep(600);
  check('moved tab left A window', (await urlsOf(aWin)).length === 2);
  check('moved tab saved into B', (await state()).workspaces[B].tabs.some((t) => t.url === U[0]));

  // 9. Resources, sections, notes, tasks
  await call('addResources', { wsId: A, items: [{ url: 'https://github.com', title: 'GitHub' }, { url: 'https://github.com', title: 'dup' }] });
  const { id: sec2 } = await call('addSection', { wsId: A, name: 'Docs' });
  let s = await state();
  const item = s.workspaces[A].sections[0].items[0];
  check('resource added once (dedup)', s.workspaces[A].sections[0].items.length === 1);
  await call('moveResource', { wsId: A, itemId: item.id, toSectionId: sec2, toIndex: 0 });
  await call('moveResource', { wsId: A, itemId: item.id, toWsId: B, toSectionId: null });
  s = await state();
  check('resource moved across workspaces', s.workspaces[B].sections[0].items.some((i) => i.id === item.id) && !s.workspaces[A].sections[1].items.length);
  await call('setNotes', { wsId: A, notes: 'hello' });
  await call('addTask', { wsId: A, text: 'ship it' });
  s = await state();
  await call('updateTask', { wsId: A, taskId: s.workspaces[A].tasks[0].id, patch: { done: true } });
  await call('clearDoneTasks', { wsId: A });
  s = await state();
  check('notes saved', s.workspaces[A].notes === 'hello');
  check('tasks add/complete/clear', s.workspaces[A].tasks.length === 0);

  // 10. A reopened window (same URLs) is re-linked to its workspace automatically
  await call('closeWorkspace', { id: A });
  await sleep(400);
  const savedA = (await state()).workspaces[A].tabs.map((t) => t.url);
  const reopened = await chrome.windows.create({ url: savedA, focused: false });
  const t0 = Date.now();
  const seen = [];
  const onCh = (c, area) => area === 'session' && c.windowMap && seen.push([Date.now() - t0, JSON.stringify(c.windowMap.newValue)]);
  chrome.storage.onChanged.addListener(onCh);
  const linked = await waitFor(async () => (await winMap())[reopened.id] === A, 10000);
  chrome.storage.onChanged.removeListener(onCh);
  check('reopened window re-linked to A', linked, { map: await winMap(), A, reopened: reopened.id, savedA, elapsed: Date.now() - t0, seen });

  // 11. Archive / duplicate / reorder / delete
  const { id: C } = await call('duplicateWorkspace', { id: B });
  s = await state();
  check('duplicate placed after original', s.order.indexOf(C) === s.order.indexOf(B) + 1 && s.workspaces[C].name.startsWith('Beta'));
  await call('setArchived', { id: C, archived: true });
  check('archive flag', (await state()).workspaces[C].archived === true);
  await call('reorderWorkspaces', { order: [C, B, A] });
  check('reorder', (await state()).order.join() === [C, B, A].join());
  await call('deleteWorkspace', { id: C });
  check('delete', !(await state()).workspaces[C]);

  // 12. Export / import (merge)
  const exported = await call('exportData');
  check('export has app marker', exported.app === 'open-workspaces' && Object.keys(exported.state.workspaces).length === 2);
  const res = await call('importData', { data: exported, mode: 'merge' });
  check('import merge doubles workspaces', res.count === 4);

  // 13. Settings round-trip
  await call('updateSettings', { patch: { suspend: { mode: 'auto', maxTabs: 3 }, theme: 'dark' } });
  s = await state();
  check('nested settings merge', s.settings.suspend.mode === 'auto' && s.settings.suspend.maxTabs === 3 && s.settings.suspend.neverPinned === true && s.settings.theme === 'dark');
  check('auto-suspend alarm created', !!(await chrome.alarms.get('ow-auto-suspend')));

  return checks;
}

/** Demo data used for README screenshots (SCREENSHOTS=1). */
function demoState() {
  const id = (n) => `demo-${n}`;
  const item = (url, title) => ({ id: `${Math.random()}`, url, title, addedAt: Date.now() });
  const tab = (url, title, extra = {}) => ({ url, title, favIconUrl: '', pinned: false, active: false, groupKey: null, ...extra });
  const ws = (n, name, icon, color, extra) => ({
    id: id(n), name, icon, color, createdAt: Date.now(), updatedAt: Date.now(), lastOpenedAt: Date.now() - n * 36e5 * 7,
    archived: false, tabs: [], groups: [], sections: [{ id: `s${n}`, name: '', collapsed: false, items: [] }], notes: '', tasks: [], ...extra,
  });
  const work = ws(1, 'Work', '💼', '#6366f1', {
    tabs: [
      tab('https://mail.google.com/', 'Inbox (3)', { pinned: true }),
      tab('https://github.com/open-workspaces/open-workspaces/pulls', 'Pull requests · open-workspaces', { active: true, groupKey: 'g1' }),
      tab('https://github.com/open-workspaces/open-workspaces/issues', 'Issues · open-workspaces', { groupKey: 'g1' }),
      tab('https://linear.app/team/cycle', 'Current cycle · Linear'),
      tab('https://calendar.google.com/', 'Calendar - This week'),
    ],
    groups: [{ key: 'g1', title: 'Review', color: 'blue', collapsed: false }],
    sections: [
      { id: 'w1', name: 'Daily', collapsed: false, items: [item('https://github.com/notifications', 'GitHub notifications'), item('https://app.slack.com/', 'Slack'), item('https://linear.app/', 'Linear board')] },
      { id: 'w2', name: 'Docs', collapsed: false, items: [item('https://developer.chrome.com/docs/extensions', 'Chrome extension docs'), item('https://www.notion.so/', 'Team wiki')] },
    ],
    tasks: [
      { id: 't1', text: 'Review PR #42 (tab groups restore)', done: false, createdAt: 1 },
      { id: 't2', text: 'Reply to the Reddit thread', done: false, createdAt: 2 },
      { id: 't3', text: 'Ship v0.1.0', done: true, createdAt: 3 },
    ],
    notes: 'Standup: tab suspension done, next is sync.\n\nIdeas:\n- Workspace templates\n- Firefox port',
  });
  const side = ws(2, 'Side project', '🚀', '#ec4899', { tabs: [tab('https://vercel.com/dashboard', 'Dashboard · Vercel'), tab('https://stripe.com/docs', 'Stripe docs')] });
  const travel = ws(3, 'Japan trip', '✈️', '#14b8a6', { tabs: [tab('https://www.google.com/maps', 'Google Maps'), tab('https://www.booking.com/', 'Booking.com'), tab('https://www.japan-guide.com/', 'japan-guide.com')] });
  const reading = ws(4, 'Reading list', '📚', '#f97316', { tabs: [tab('https://news.ycombinator.com/', 'Hacker News')] });
  const music = ws(5, 'Music', '', '#22c55e', { tabs: [tab('https://open.spotify.com/', 'Spotify')] });
  const list = [work, side, travel, reading, music];
  return { order: list.map((w) => w.id), workspaces: Object.fromEntries(list.map((w) => [w.id, w])), settings: {} };
}

async function captureScreens(port, extId, dir) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const shots = [
    { name: 'dashboard', path: 'dashboard/dashboard.html#/ws/demo-1', w: 1280, h: 800 },
    { name: 'dashboard-resources', path: 'dashboard/dashboard.html#/ws/demo-1', w: 1280, h: 800, view: 'resources' },
    { name: 'popup', path: 'popup/popup.html', w: 360, h: 560, bind: true },
    { name: 'sidepanel', path: 'sidepanel/sidepanel.html', w: 400, h: 760, view: 'resources', bind: true },
    { name: 'settings', path: 'dashboard/dashboard.html#/settings', w: 1280, h: 1000 },
  ];
  for (const dark of [false, true]) {
    for (const shot of shots) {
      const target = await getJson(port, `/json/new?${encodeURIComponent(`chrome-extension://${extId}/src/${shot.path}`)}`, 'PUT');
      const cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.ready;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: shot.w, height: shot.h, deviceScaleFactor: 2, mobile: false });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      // Popup/side panel show the window's current workspace; the dashboard shows "Work" as closed (saved tabs).
      await cdp
        .eval(`(async () => {
          localStorage.setItem('ow:view', ${JSON.stringify(shot.view ?? 'tabs')});
          const win = await chrome.windows.getCurrent();
          await chrome.storage.session.set({ windowMap: ${shot.bind ? "{ [win.id]: 'demo-1' }" : '{}'} });
        })()`)
        .catch(() => {});
      await cdp.send('Page.reload');
      await sleep(1200);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, `${shot.name}${dark ? '-dark' : ''}.png`), Buffer.from(data, 'base64'));
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
      cdp.close();
    }
  }
  console.log(`screenshots saved to ${dir}`);
}

async function main() {
  const browser = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'ow-smoke-'));
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    // The scenario runs in a background tab; don't let Chromium throttle its timers.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(process.env.HEADED ? [] : ['--headless=new']),
    'about:blank',
  ];
  console.log(`browser: ${browser}`);
  const proc = spawn(browser, args, { stdio: 'ignore' });
  let exitCode = 1;
  try {
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(150);
      try {
        port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      } catch {}
    }
    if (!port) throw new Error('browser did not expose a DevTools port');

    let extId = null;
    for (let i = 0; i < 60 && !extId; i++) {
      const targets = await getJson(port, '/json/list');
      const sw = targets.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith('service-worker.js'));
      if (sw) extId = new URL(sw.url).host;
      else await sleep(250);
    }
    if (!extId) throw new Error('extension service worker not found (does this browser allow --load-extension?)');
    console.log(`extension: ${extId}`);

    const sw = (await getJson(port, '/json/list')).find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const swCdp = new Cdp(sw.webSocketDebuggerUrl);
    await swCdp.ready;
    await swCdp.send('Runtime.enable');

    const pages = {};
    for (const name of ['dashboard', 'popup', 'sidepanel']) {
      const target = await getJson(port, `/json/new?chrome-extension://${extId}/src/${name}/${name}.html`, 'PUT');
      const cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.ready;
      await cdp.send('Runtime.enable');
      pages[name] = cdp;
    }
    await sleep(1500);

    const checks = await pages.dashboard.eval(`(${scenario.toString()})()`);
    await sleep(800);

    for (const name of ['dashboard', 'popup', 'sidepanel']) {
      const rendered = await pages[name].eval(`document.getElementById('app').children.length > 0 && document.body.innerText.length > 20`);
      checks.push({ name: `${name} page renders`, ok: rendered, detail: '' });
    }
    const dashText = await pages.dashboard.eval('document.body.innerText');
    checks.push({ name: 'dashboard lists workspaces', ok: dashText.includes('Alpha') && dashText.includes('Beta'), detail: dashText.slice(0, 200) });

    if (process.env.DEBUG) console.log(swCdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => e.params.args.map((a) => a.value ?? a.description).join(' ')));
    for (const [name, cdp] of [...Object.entries(pages), ['service-worker', swCdp]]) {
      const errs = cdp.errors();
      checks.push({ name: `no errors in ${name}`, ok: errs.length === 0, detail: errs.slice(0, 3) });
    }

    let failed = 0;
    for (const c of checks) {
      console.log(`${c.ok ? '  ✔' : '  ✖'} ${c.name}${c.ok ? '' : `  ${c.detail}`}`);
      if (!c.ok) failed++;
    }
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    exitCode = failed ? 1 : 0;

    if (process.env.SCREENSHOTS) {
      await pages.dashboard.eval(`(async () => {
        await chrome.runtime.sendMessage({ type: 'ow:call', action: 'importData', payload: { data: ${JSON.stringify(demoState())}, mode: 'replace' } });
        await chrome.runtime.sendMessage({ type: 'ow:call', action: 'updateSettings', payload: { patch: { theme: 'system' } } });
      })()`);
      await captureScreens(port, extId, resolve(process.env.SCREENSHOTS === '1' ? 'docs/screenshots' : process.env.SCREENSHOTS));
    }
    for (const cdp of Object.values(pages)) cdp.close();
    swCdp.close();
  } catch (err) {
    console.error(err);
  } finally {
    proc.kill();
    await sleep(800);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
  process.exit(exitCode);
}

main();
