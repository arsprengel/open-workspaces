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

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
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
  const HOME = chrome.runtime.getURL('src/home/home.html');
  const isHome = (t) => (t.pendingUrl || t.url || '').startsWith(HOME);
  const tabsOf = async (windowId) => (await chrome.tabs.query({ windowId })).filter((t) => !isHome(t));
  const urlsOf = async (windowId) => (await tabsOf(windowId)).map((t) => t.pendingUrl || t.url);
  const homesOf = async (windowId) => (await chrome.tabs.query({ windowId })).filter(isHome);
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
  check('new window gets the home tab', await waitFor(async () => (await homesOf(win.id)).length === 1));
  const [home] = await homesOf(win.id);
  check('home tab is pinned at the far left', home?.pinned && home.index === 0, home);
  await sleep(600);
  check('home tab is not saved into the workspace', !(await state()).workspaces[A].tabs.some((t) => t.url.startsWith(HOME)));

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
  const restored = await tabsOf(win.id);
  check('A restored with its 3 URLs', restored.map((t) => t.pendingUrl || t.url).join() === U.join(), restored.map((t) => t.url));
  check('home tab survives switching', (await homesOf(win.id)).length === 1 && (await homesOf(win.id))[0].index === 0);
  // The home tab is in front after a switch; the workspace's last used tab stays loaded, ready to click.
  check('restored tabs other than the last used one get discarded', await waitFor(async () => (await tabsOf(win.id)).filter((t) => !t.discarded).length === 1));
  const disc = await tabsOf(win.id);
  check('discarded tabs keep their URL', disc.every((t) => U.includes(t.url)), disc.map((t) => t.url));
  check('B kept example.org after switching away', (await state()).workspaces[B].tabs.some((t) => t.url.startsWith('https://example.org')));

  // 4b. Pinned tabs belong to the window: they stay put when switching and aren't saved into workspaces
  const PIN = 'https://example.net/';
  await chrome.tabs.create({ windowId: win.id, url: PIN, pinned: true, active: false });
  await sleep(900);
  check('pinned tab is not saved into A', !(await state()).workspaces[A].tabs.some((t) => t.url === PIN), (await state()).workspaces[A].tabs);
  await call('openWorkspace', { id: B, windowId: win.id });
  const pinnedAfter = (await tabsOf(win.id)).filter((t) => t.pinned).map((t) => t.pendingUrl || t.url);
  check('pinned tab stays when switching to B', pinnedAfter.length === 1 && pinnedAfter[0] === PIN, pinnedAfter);
  await sleep(600);
  check('pinned tab is not saved into B', !(await state()).workspaces[B].tabs.some((t) => t.url === PIN));
  await call('openWorkspace', { id: A, windowId: win.id });
  check('back in A: pinned tab still there once, A tabs intact', (await urlsOf(win.id)).join() === [PIN, ...U].join(), await urlsOf(win.id));
  await chrome.tabs.remove((await tabsOf(win.id)).filter((t) => t.pinned).map((t) => t.id));
  await sleep(600);

  // 4c. Turning the home tab off removes it everywhere; turning it on brings it back
  await call('updateSettings', { patch: { homeTab: false } });
  check('home tab removed when turned off', await waitFor(async () => !(await homesOf(win.id)).length));
  await call('updateSettings', { patch: { homeTab: true } });
  check('home tab back when turned on', await waitFor(async () => (await homesOf(win.id)).length === 1));

  // 4d. The home tab's icon is the window's workspace and follows it when switching
  const homeIcon = async () => (await homesOf(win.id))[0]?.favIconUrl ?? '';
  check('home tab icon is the workspace', await waitFor(async () => (await homeIcon()).startsWith('data:image/png')), await homeIcon());
  const iconA = await homeIcon();
  await call('openWorkspace', { id: B, windowId: win.id });
  check('home tab icon follows the workspace', await waitFor(async () => (await homeIcon()).startsWith('data:image/png') && (await homeIcon()) !== iconA));
  await call('openWorkspace', { id: A, windowId: win.id });
  check('home tab icon comes back', await waitFor(async () => (await homeIcon()) === iconA));

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
  const [first] = await tabsOf(aWin);
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
  await call('updateSettings', { patch: { suspend: { mode: 'manual' } } });

  // 14. Dragging a tab into another workspace's window moves it to that workspace
  const w1 = await chrome.windows.create({ url: ['https://example.com/?w1a', 'https://example.com/?w1b'], focused: false });
  const w2 = await chrome.windows.create({ url: ['https://example.com/?w2a'], focused: false });
  await sleep(700);
  const { id: D1 } = await call('createWorkspace', { name: 'Drag from', fromWindowId: w1.id });
  const { id: D2 } = await call('createWorkspace', { name: 'Drag to', fromWindowId: w2.id });
  const [dragged] = (await tabsOf(w1.id)).filter((t) => (t.pendingUrl || t.url).includes('w1b'));
  await chrome.tabs.move(dragged.id, { windowId: w2.id, index: -1 });
  check('tab dragged to another window joins its workspace', await waitFor(async () => {
    const s = await state();
    return s.workspaces[D2].tabs.some((t) => t.url.includes('w1b')) && !s.workspaces[D1].tabs.some((t) => t.url.includes('w1b'));
  }));

  return checks;
}

/** Uploads an image through the real workspace form (file input -> preview -> Save) and checks it was stored. */
async function uploadCheck(cdp, file) {
  const wsId = await cdp.eval(`(async () => {
    const { state } = await chrome.storage.local.get('state');
    const id = state.order[0];
    location.hash = '#/ws/' + id;
    return id;
  })()`);
  await sleep(700);
  await cdp.eval(`document.querySelector('.sidebar .sw-field').click()`);
  await sleep(300);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.modal input[type=file]' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await sleep(800);
  const preview = await cdp.eval(`!!document.querySelector('.identity .sw-field img')`);
  await cdp.eval(`document.querySelector('.modal button[type=submit]').click()`);
  await sleep(800);
  const stored = await cdp.eval(`chrome.storage.local.get('state').then(({ state }) => state.workspaces[${JSON.stringify(wsId)}].image || '')`);
  const name = file.split('.').pop().toUpperCase();
  return [
    { name: `${name} upload shows in the form preview`, ok: preview, detail: '' },
    { name: `${name} upload is saved to the workspace`, ok: stored.startsWith('data:image/png;base64,'), detail: JSON.stringify(stored.slice(0, 40)) },
  ];
}

/**
 * The toolbar popup closes as soon as the system file chooser takes focus, so "Upload image" there must
 * save the workspace and continue in a full page editor instead of opening the chooser.
 */
async function popupUploadCheck(port, cdp, dash) {
  await cdp.send('Page.reload');
  await sleep(900);
  await cdp.eval(`document.querySelector('.popup-foot .btn').click()`);
  await sleep(300);
  await cdp.eval(`(() => { const i = document.querySelector('#ws-name'); i.focus(); document.execCommand('insertText', false, 'From popup'); })()`);
  // Fire and forget: the popup closes itself once the editor opens, so no reply would come back.
  cdp.send('Runtime.evaluate', { expression: `document.querySelector('.modal .field-row .btn').click()` }).catch(() => {});
  await sleep(1500);
  const id = await dash.eval(`chrome.storage.local.get('state').then(({ state }) => Object.values(state.workspaces).find((w) => w.name === 'From popup')?.id ?? null)`).catch(() => null);
  const editor = id && (await getJson(port, '/json/list')).find((x) => x.url.endsWith(`dashboard.html#/ws/${id}/edit`));
  let formOpen = false;
  if (editor) {
    const page = new Cdp(editor.webSocketDebuggerUrl);
    await page.ready;
    await sleep(600);
    formOpen = await page.eval(`!!document.querySelector('.modal input[type=file]')`);
    page.close();
  }
  return [
    { name: 'popup upload saves the new workspace', ok: !!id, detail: '' },
    { name: 'popup upload continues in the full page editor', ok: !!editor && formOpen, detail: JSON.stringify({ editor: !!editor, formOpen }) },
  ];
}

/**
 * A background tab gets its timers held back by the browser (for minutes, after a while) and paints no
 * frames, so animation frames and img.decode() never settle. The home tab sits in the background whenever
 * you switch, so its icon must update without them, also for a workspace with an uploaded image.
 */
async function backgroundIconCheck(port, dash, mode, image) {
  const info = await dash.eval(`(async () => {
    const { state } = await chrome.storage.local.get('state');
    const { windowMap } = await chrome.storage.session.get('windowMap');
    const from = Object.values(state.workspaces).find((w) => w.name === ${JSON.stringify(mode === 'throttled' ? 'Drag from' : 'Drag to')});
    const open = new Set(Object.values(windowMap));
    const target = state.order.find((id) => !open.has(id) && !state.workspaces[id].archived);
    const windowId = Number(Object.keys(windowMap).find((k) => windowMap[k] === from.id));
    const home = (await chrome.tabs.query({ windowId })).find((t) => t.url.startsWith(chrome.runtime.getURL('src/home/home.html')));
    const url = chrome.runtime.getURL('src/home/home.html') + '#probe-${mode}';
    await chrome.tabs.update(home.id, { url });
    await chrome.runtime.sendMessage({ type: 'ow:call', action: 'updateWorkspace', payload: { id: target, patch: { image: ${JSON.stringify(image)} } } });
    return { windowId, homeId: home.id, url, target };
  })()`);
  await sleep(1000);
  const page = (await getJson(port, '/json/list')).find((x) => x.url === info.url);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  if (mode === 'throttled') {
    // Nothing scheduled on timers or animation frames ever runs, and no image decode ever finishes.
    await cdp.eval(`window.setTimeout = () => 0; window.requestAnimationFrame = () => 0; HTMLImageElement.prototype.decode = () => new Promise(() => {});`);
  } else {
    // After a while in the background the browser freezes the page: no script runs until it's shown.
    await cdp.send('Page.enable');
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  }
  const icon = () => dash.eval(`chrome.tabs.get(${info.homeId}).then((t) => t.favIconUrl || '')`);
  const before = await icon();
  await dash.eval(`chrome.runtime.sendMessage({ type: 'ow:call', action: 'openWorkspace', payload: { id: ${JSON.stringify(info.target)}, windowId: ${info.windowId} } })`);
  let after = before;
  for (let i = 0; i < 20 && (after === before || !after.startsWith('data:image')); i++) {
    await sleep(150);
    after = await icon();
  }
  cdp.close();
  return [{ name: `home tab icon updates while ${mode} in the background`, ok: after !== before && after.startsWith('data:image'), detail: '' }];
}

/**
 * Serves a stand-in for web.whatsapp.com over HTTPS (self-signed, the browser maps the host here), so
 * the pin suggestion for always-on sites can be tested without a real account. Null without openssl.
 */
async function startPinSite(dir) {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=web.whatsapp.com',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>WhatsApp</title><p>Local stand-in for web.whatsapp.com');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

/**
 * Opening an always-on site in an unpinned tab asks in the toolbar popup whether to pin it: "Pin tab"
 * pins it, the same site isn't offered twice in a browser session, and "Don't ask again" mutes it.
 */
async function pinSuggestCheck(port, dash) {
  const known = new Set((await getJson(port, '/json/list')).map((x) => x.id));
  const waitPopup = async (ms) => {
    for (let waited = 0; waited < ms; waited += 200) {
      await sleep(200);
      const target = (await getJson(port, '/json/list')).find((x) => x.url.includes('/src/popup/popup.html') && !known.has(x.id));
      if (target) {
        known.add(target.id);
        const cdp = new Cdp(target.webSocketDebuggerUrl);
        await cdp.ready;
        await sleep(500);
        return cdp;
      }
    }
    return null;
  };
  const windows = [];
  const openSite = async () => {
    const id = await dash.eval(`chrome.windows.create({ url: 'https://web.whatsapp.com/', focused: true }).then((w) => w.id)`);
    windows.push(id);
    return id;
  };
  const siteTab = (windowId) => dash.eval(`chrome.tabs.query({ windowId: ${windowId} }).then((ts) => ts.find((t) => t.url.startsWith('https://web.whatsapp.com')) ?? null)`);
  // The popup closes itself on click, so no reply would come back.
  const click = (cdp, selector) => cdp.send('Runtime.evaluate', { expression: `document.querySelector('${selector}').click()` }).catch(() => {});
  const forgetAsked = () => dash.eval(`chrome.storage.session.remove('pinAsked')`);

  const w1 = await openSite();
  const ask = await waitPopup(6000);
  const text = ask ? await ask.eval(`document.querySelector('.pin-ask')?.innerText ?? ''`) : '';
  if (ask) click(ask, '.pin-ask .btn.primary');
  await sleep(1000);
  const pinned = (await siteTab(w1))?.pinned === true;

  await openSite();
  const again = await waitPopup(2500);
  again?.close();

  await forgetAsked();
  await openSite();
  const muteAsk = await waitPopup(6000);
  if (muteAsk) click(muteAsk, '.pin-ask-mute');
  await sleep(1000);
  const muted = await dash.eval(`chrome.storage.local.get('state').then(({ state }) => state.settings.pinMuted.whatsapp === true)`);
  await forgetAsked();
  await openSite();
  const afterMute = await waitPopup(2500);
  afterMute?.close();

  await dash.eval(`(async () => {
    for (const id of ${JSON.stringify(windows)}) await chrome.windows.remove(id).catch(() => {});
    await chrome.runtime.sendMessage({ type: 'ow:call', action: 'updateSettings', payload: { patch: { pinMuted: { whatsapp: false } } } });
  })()`);
  return [
    { name: 'opening WhatsApp asks to pin it in the popup', ok: text.includes('WhatsApp'), detail: text.slice(0, 120) },
    { name: '"pin tab" pins the tab', ok: pinned, detail: '' },
    { name: 'the same site is offered once per session', ok: !again, detail: '' },
    { name: '"don\'t ask again" mutes the site', ok: muted && !afterMute, detail: JSON.stringify({ muted, askedAfterMute: !!afterMute }) },
  ];
}

/**
 * A tab marked to keep running survives switching away: it waits, still loaded, in a collapsed group named
 * after its workspace, and comes back in place without a reload. Closed while waiting, it comes back
 * reloaded (and still marked); deleting its workspace closes it.
 */
async function keepAliveCheck(port, dash) {
  const K = ['https://example.com/?keep1', 'https://example.com/?keep2'];
  const ev = (code) => dash.eval(`(async () => {
    const call = async (action, payload = {}) => {
      const r = await chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
      if (!r?.ok) throw new Error(action + ': ' + r?.error);
      return r.result;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const own = async (windowId) => (await chrome.tabs.query({ windowId })).filter((t) => !t.url.startsWith(chrome.runtime.getURL('')));
    ${code}
  })()`);
  const s = await ev(`
    const win = await chrome.windows.create({ url: ${JSON.stringify(K)}, focused: false });
    await sleep(2500);
    const { id: keep } = await call('createWorkspace', { name: 'Keep', icon: '⚡', color: '#22c55e', fromWindowId: win.id });
    const { id: other } = await call('createWorkspace', { name: 'Other' });
    const kept = (await chrome.tabs.query({ windowId: win.id })).find((t) => t.url === ${JSON.stringify(K[1])});
    return { windowId: win.id, keep, other, keptId: kept.id };`);
  const target = (await getJson(port, '/json/list')).find((x) => x.url === K[1]);
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.ready;
  await page.eval(`window.__kept = 'still here'`);
  const alive = () => page.eval(`window.__kept`).catch(() => null);

  const marked = await ev(`
    await call('setKeepAlive', { tabId: ${s.keptId}, keep: true });
    await sleep(300);
    const { state } = await chrome.storage.local.get('state');
    return state.workspaces[${JSON.stringify(s.keep)}].tabs.map((t) => !!t.keepAlive).join();`);

  const away = await ev(`
    await call('openWorkspace', { id: ${JSON.stringify(s.other)}, windowId: ${s.windowId} });
    await sleep(1200);
    const tab = await chrome.tabs.get(${s.keptId}).catch(() => null);
    const group = tab && tab.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId) : null;
    const urls = (await own(${s.windowId})).map((t) => t.url);
    const { state } = await chrome.storage.local.get('state');
    return {
      inWindow: tab?.windowId === ${s.windowId},
      group: group && { title: group.title, color: group.color, collapsed: group.collapsed },
      otherClosed: !urls.includes(${JSON.stringify(K[0])}),
      notSavedInOther: !state.workspaces[${JSON.stringify(s.other)}].tabs.some((t) => t.url === ${JSON.stringify(K[1])}),
      last: (await chrome.tabs.query({ windowId: ${s.windowId} })).at(-1)?.id === ${s.keptId},
    };`);
  const aliveAway = await alive();

  const back = await ev(`
    await call('openWorkspace', { id: ${JSON.stringify(s.keep)}, windowId: ${s.windowId} });
    await sleep(800);
    const tabs = await own(${s.windowId});
    const { keepAlive } = await chrome.storage.session.get('keepAlive');
    return {
      urls: tabs.map((t) => t.pendingUrl || t.url).join(),
      sameTab: tabs[1]?.id === ${s.keptId},
      ungrouped: tabs.every((t) => t.groupId === -1),
      groupsLeft: (await chrome.tabGroups.query({ windowId: ${s.windowId} })).length,
      stillMarked: !!keepAlive?.[${s.keptId}],
    };`);
  const aliveBack = await alive();
  page.close();

  const reopened = await ev(`
    await call('openWorkspace', { id: ${JSON.stringify(s.other)}, windowId: ${s.windowId} });
    await sleep(800);
    await chrome.tabs.remove(${s.keptId});
    await sleep(300);
    await call('openWorkspace', { id: ${JSON.stringify(s.keep)}, windowId: ${s.windowId} });
    await sleep(800);
    const tabs = await own(${s.windowId});
    const again = tabs.find((t) => (t.pendingUrl || t.url) === ${JSON.stringify(K[1])});
    const { keepAlive } = await chrome.storage.session.get('keepAlive');
    return { back: !!again && again.id !== ${s.keptId}, marked: !!again && !!keepAlive?.[again.id], loaded: !!again && !again.discarded, id: again?.id };`);

  const deleted = await ev(`
    await call('openWorkspace', { id: ${JSON.stringify(s.other)}, windowId: ${s.windowId} });
    await sleep(800);
    const parkedBefore = !!(await chrome.tabs.get(${reopened.id ?? -1}).catch(() => null))?.groupId;
    await call('deleteWorkspace', { id: ${JSON.stringify(s.keep)} });
    await sleep(500);
    const gone = !(await chrome.tabs.get(${reopened.id ?? -1}).catch(() => null));
    const groupsLeft = (await chrome.tabGroups.query({ windowId: ${s.windowId} })).length;
    await chrome.windows.remove(${s.windowId});
    await call('deleteWorkspace', { id: ${JSON.stringify(s.other)} });
    return { parkedBefore, gone, groupsLeft };`);

  return [
    { name: 'keep-alive mark is saved with the tab', ok: marked === 'false,true', detail: marked },
    { name: 'switching away parks the kept tab in a collapsed group named after its workspace', ok: away.inWindow && away.last && away.group?.title === '⚡ Keep' && away.group.collapsed && away.group.color === 'green', detail: JSON.stringify(away) },
    { name: 'the other tabs close and the parked tab is not saved into the new workspace', ok: away.otherClosed && away.notSavedInOther, detail: JSON.stringify(away) },
    { name: 'the parked tab keeps running (no reload)', ok: aliveAway === 'still here', detail: String(aliveAway) },
    { name: 'switching back returns the same tab in place, out of the group', ok: back.urls === K.join() && back.sameTab && back.ungrouped && back.groupsLeft === 0 && back.stillMarked, detail: JSON.stringify(back) },
    { name: 'the returned tab was never reloaded', ok: aliveBack === 'still here', detail: String(aliveBack) },
    { name: 'a kept tab closed while parked comes back loaded and still marked', ok: reopened.back && reopened.marked && reopened.loaded, detail: JSON.stringify(reopened) },
    { name: 'deleting the workspace closes its parked tab', ok: deleted.gone && deleted.groupsLeft === 0, detail: JSON.stringify(deleted) },
  ];
}

/**
 * Switching workspaces lands on the home tab (the Open Workspaces page) instead of the workspace's first
 * tab; the tab you last used there still loads, ready to click. With the setting off, the old behavior.
 */
async function homeOnSwitchCheck(dash) {
  const H = ['https://example.com/?h1', 'https://example.com/?h2', 'https://example.com/?h3'];
  const r = await dash.eval(`(async () => {
    const call = async (action, payload = {}) => {
      const r = await chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
      if (!r?.ok) throw new Error(action + ': ' + r?.error);
      return r.result;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const HOME = chrome.runtime.getURL('src/home/home.html');
    const active = async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0];
    // Every tab brought to the front during a switch: anything but the home tab is a visible flash.
    const fronted = [];
    const onActivated = ({ tabId, windowId }) => fronted.push({ tabId, windowId });
    chrome.tabs.onActivated.addListener(onActivated);
    const homeOf = async (windowId) => (await chrome.tabs.query({ windowId })).find((t) => (t.pendingUrl || t.url).startsWith(HOME))?.id;
    const flashes = async (windowId) => {
      const home = await homeOf(windowId);
      return fronted.splice(0).filter((a) => a.windowId === windowId && a.tabId !== home).length;
    };
    const win = await chrome.windows.create({ url: ${JSON.stringify(H)}, focused: false });
    await sleep(2000);
    const { id: one } = await call('createWorkspace', { name: 'Home one', fromWindowId: win.id });
    const { id: two } = await call('createWorkspace', { name: 'Home two' });
    const used = (await chrome.tabs.query({ windowId: win.id })).find((t) => t.url === ${JSON.stringify(H[1])});
    await chrome.tabs.update(used.id, { active: true });
    await sleep(600);

    fronted.length = 0;
    await call('openWorkspace', { id: two, windowId: win.id });
    await sleep(300);
    const flashAway = await flashes(win.id);
    const onHomeAway = (await active(win.id))?.url.startsWith(HOME);
    await call('openWorkspace', { id: one, windowId: win.id });
    await sleep(1500);
    const flashBack = await flashes(win.id);
    const onHomeBack = (await active(win.id))?.url.startsWith(HOME);
    const tabs = (await chrome.tabs.query({ windowId: win.id })).filter((t) => !t.url.startsWith(HOME));
    const lastUsedLoaded = tabs.find((t) => (t.pendingUrl || t.url) === ${JSON.stringify(H[1])})?.discarded === false;
    const othersLazy = tabs.filter((t) => (t.pendingUrl || t.url) !== ${JSON.stringify(H[1])}).every((t) => t.discarded);

    await call('updateSettings', { patch: { homeOnSwitch: false } });
    await call('openWorkspace', { id: two, windowId: win.id });
    await call('openWorkspace', { id: one, windowId: win.id });
    const offLandsOnTab = (await active(win.id))?.pendingUrl === ${JSON.stringify(H[1])} || (await active(win.id))?.url === ${JSON.stringify(H[1])};
    await call('updateSettings', { patch: { homeOnSwitch: true } });

    fronted.length = 0;
    const { windowId: other } = await call('openWorkspace', { id: two, newWindow: true });
    await sleep(300);
    const flashNew = await flashes(other);
    const onHomeNew = (await active(other))?.url.startsWith(HOME);
    chrome.tabs.onActivated.removeListener(onActivated);

    for (const id of [win.id, other]) await chrome.windows.remove(id);
    for (const id of [one, two]) await call('deleteWorkspace', { id });
    return { onHomeAway, onHomeBack, onHomeNew, flashAway, flashBack, flashNew, lastUsedLoaded, othersLazy, offLandsOnTab };
  })()`);
  return [
    { name: 'switching workspaces lands on the Open Workspaces page', ok: r.onHomeAway && r.onHomeBack && r.onHomeNew, detail: JSON.stringify(r) },
    { name: 'no workspace tab flashes in front before the Open Workspaces page', ok: !r.flashAway && !r.flashBack && !r.flashNew, detail: JSON.stringify(r) },
    { name: 'the tab last used in the workspace is loaded, the others wait', ok: r.lastUsedLoaded && r.othersLazy, detail: JSON.stringify(r) },
    { name: 'with the setting off, switching opens the last used tab', ok: r.offLandsOnTab, detail: JSON.stringify(r) },
  ];
}

/**
 * The tabs of a workspace you switch away from wait, still running, in a collapsed group; coming back puts
 * them back in place without a reload. Unused for the wait they close, except tabs marked to keep running.
 */
async function warmCheck(port, dash) {
  const W = ['https://example.com/?warm1', 'https://example.com/?warm2'];
  const ev = (code) => dash.eval(`(async () => {
    const call = async (action, payload = {}) => {
      const r = await chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
      if (!r?.ok) throw new Error(action + ': ' + r?.error);
      return r.result;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const own = async (windowId) => (await chrome.tabs.query({ windowId })).filter((t) => !t.url.startsWith(chrome.runtime.getURL('')));
    const get = (id) => chrome.tabs.get(id).catch(() => null);
    ${code}
  })()`);
  const s = await ev(`
    await call('updateSettings', { patch: { waitMinutes: 15 } });
    const win = await chrome.windows.create({ url: ${JSON.stringify(W)}, focused: false });
    await sleep(2500);
    const { id: warm } = await call('createWorkspace', { name: 'Warm', icon: '🔥', color: '#f97316', fromWindowId: win.id });
    const { id: other } = await call('createWorkspace', { name: 'Elsewhere' });
    return { windowId: win.id, warm, other, ids: (await own(win.id)).map((t) => t.id) };`);
  const { windowId, warm, other, ids } = s;
  const target = (await getJson(port, '/json/list')).find((x) => x.url === W[1]);
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.ready;
  await page.eval(`window.__warm = 'still here'`);
  const alive = () => page.eval(`window.__warm`).catch(() => null);

  const away = await ev(`
    await call('openWorkspace', { id: ${JSON.stringify(other)}, windowId: ${windowId} });
    await sleep(1000);
    const tabs = await Promise.all(${JSON.stringify(ids)}.map(get));
    const group = tabs[0]?.groupId >= 0 ? await chrome.tabGroups.get(tabs[0].groupId) : null;
    const { state } = await chrome.storage.local.get('state');
    return {
      waiting: tabs.every((t) => t && t.windowId === ${windowId} && t.groupId >= 0 && t.groupId === tabs[0].groupId),
      collapsed: !!group?.collapsed && group.title === '🔥 Warm' && group.color === 'orange',
      notInOther: !state.workspaces[${JSON.stringify(other)}].tabs.some((t) => t.url.includes('warm')),
      alarm: !!(await chrome.alarms.get('ow-parked')),
    };`);
  const aliveAway = await alive();

  const back = await ev(`
    await call('openWorkspace', { id: ${JSON.stringify(warm)}, windowId: ${windowId} });
    await sleep(800);
    const tabs = await own(${windowId});
    return {
      same: tabs.map((t) => t.id).join() === ${JSON.stringify(ids.join())},
      ungrouped: tabs.every((t) => t.groupId === -1),
      groups: (await chrome.tabGroups.query({ windowId: ${windowId} })).length,
    };`);
  const aliveBack = await alive();
  page.close();

  // A short wait runs out: the unmarked tab closes, the one marked to keep running stays.
  const expired = await ev(`
    await call('setKeepAlive', { tabId: ${ids[0]}, keep: true });
    await call('openWorkspace', { id: ${JSON.stringify(other)}, windowId: ${windowId} });
    await sleep(600);
    await call('updateSettings', { patch: { waitMinutes: 0.05 } });
    await sleep(6000);
    const [marked, unmarked] = await Promise.all(${JSON.stringify(ids)}.map(get));
    await call('openWorkspace', { id: ${JSON.stringify(warm)}, windowId: ${windowId} });
    await sleep(800);
    const tabs = await own(${windowId});
    return {
      markedStays: marked?.groupId >= 0,
      unmarkedClosed: !unmarked,
      backInOrder: tabs.map((t) => t.pendingUrl || t.url).join() === ${JSON.stringify(W.join())} && tabs[0].id === ${ids[0]},
    };`);

  // Turned off: the tabs waiting close at once.
  const off = await ev(`
    await call('setKeepAlive', { tabId: ${ids[0]}, keep: false });
    await call('updateSettings', { patch: { waitMinutes: 15 } });
    const before = (await own(${windowId})).map((t) => t.id);
    await call('openWorkspace', { id: ${JSON.stringify(other)}, windowId: ${windowId} });
    await sleep(600);
    const waited = (await Promise.all(before.map(get))).every((t) => t?.groupId >= 0);
    await call('updateSettings', { patch: { waitMinutes: 0 } });
    await sleep(800);
    const gone = (await Promise.all(before.map(get))).every((t) => !t);
    await chrome.windows.remove(${windowId});
    for (const id of [${JSON.stringify(warm)}, ${JSON.stringify(other)}]) await call('deleteWorkspace', { id });
    return { waited, gone };`);

  const detail = JSON.stringify({ away, aliveAway, back, aliveBack, expired, off });
  return [
    { name: 'tabs of the workspace left behind wait, still running, in its collapsed group', ok: away.waiting && away.collapsed && away.notInOther && away.alarm && aliveAway === 'still here', detail },
    { name: 'coming back puts the waiting tabs back in place without a reload', ok: back.same && back.ungrouped && back.groups === 0 && aliveBack === 'still here', detail },
    { name: 'waiting tabs close once unused for the wait, marked ones stay', ok: expired.markedStays && expired.unmarkedClosed && expired.backInOrder, detail },
    { name: 'turning waiting off closes the waiting tabs', ok: off.waited && off.gone, detail },
  ];
}

/** A parked group recognised after an extension update takes its workspace's current name (it may have none). */
function parkedGroupNameCheck(dash) {
  return dash.eval(`(async () => {
    const call = async (action, payload = {}) => {
      const r = await chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
      if (!r?.ok) throw new Error(action + ': ' + r?.error);
      return r.result;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const win = await chrome.windows.create({ url: 'https://example.com/?legacy', focused: false });
    await sleep(2000);
    const { id: legacy } = await call('createWorkspace', { name: 'Legacy', fromWindowId: win.id });
    const { id: other } = await call('createWorkspace', { name: 'Legacy other' });
    const tab = (await chrome.tabs.query({ windowId: win.id })).find((t) => t.url === 'https://example.com/?legacy');
    await call('setKeepAlive', { tabId: tab.id, keep: true });
    await call('openWorkspace', { id: other, windowId: win.id });
    await sleep(800);
    const groupId = (await chrome.tabs.get(tab.id)).groupId;
    const named = (await chrome.tabGroups.get(groupId)).title === 'Legacy';
    // As an earlier version left it, and as an update finds it: untitled group, no record of the tab id.
    await chrome.tabGroups.update(groupId, { title: '' });
    const { parkedGroups } = await chrome.storage.local.get('parkedGroups');
    parkedGroups[legacy].title = '';
    await chrome.storage.local.set({ parkedGroups });
    const { parked } = await chrome.storage.session.get('parked');
    delete parked[tab.id];
    await chrome.storage.session.set({ parked });
    const { recognizeParkedGroups } = await import('/src/background/keep-alive.js');
    await recognizeParkedGroups(win.id);
    const after = (await chrome.tabGroups.get(groupId)).title;
    const tracked = !!(await chrome.storage.session.get('parked')).parked[tab.id];
    const record = (await chrome.storage.local.get('parkedGroups')).parkedGroups[legacy]?.title;
    await chrome.windows.remove(win.id);
    for (const id of [legacy, other]) await call('deleteWorkspace', { id });
    const r = { named, after, tracked, record };
    return [{ name: 'a parked group recognised after an update gets its workspace name back', ok: named && after === 'Legacy' && tracked && record === 'Legacy', detail: JSON.stringify(r) }];
  })()`);
}

/**
 * Clicking workspaces faster than a switch completes: each switch must finish before the next starts, or
 * the tabs of the workspaces in between stay in the window and get saved into the last one.
 */
function rapidSwitchCheck(dash) {
  return dash.eval(`(async () => {
    const call = async (action, payload = {}) => {
      const r = await chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
      if (!r?.ok) throw new Error(action + ': ' + r?.error);
      return r.result;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const names = ['r1', 'r2', 'r3', 'r4'];
    const ids = {};
    let windowId = null;
    for (const name of names) {
      const w = await chrome.windows.create({ url: [1, 2, 3, 4, 5, 6].map((n) => 'https://example.com/?' + name + '-' + n), focused: false });
      await sleep(1200);
      ids[name] = (await call('createWorkspace', { name: 'Rapid ' + name, fromWindowId: w.id })).id;
      await sleep(400);
      if (windowId == null) windowId = w.id;
      else await chrome.windows.remove(w.id);
    }
    const own = (u, name) => u.split('?')[1]?.startsWith(name + '-');
    const clean = async () => {
      const { state } = await chrome.storage.local.get('state');
      return names.every((n) => {
        const urls = state.workspaces[ids[n]].tabs.map((t) => t.url);
        return urls.length === 6 && urls.every((u) => own(u, n));
      });
    };
    const rounds = [];
    for (const gap of [0, 60, 250]) {
      const clicks = ['r2', 'r3', 'r4', 'r1', 'r2', 'r3'];
      const runs = [];
      for (const name of clicks) {
        runs.push(call('openWorkspace', { id: ids[name], windowId }));
        await sleep(gap);
      }
      await Promise.all(runs);
      await sleep(2500);
      const live = (await chrome.tabs.query({ windowId })).map((t) => t.pendingUrl || t.url).filter((u) => u.startsWith('https://'));
      const { windowMap } = await chrome.storage.session.get('windowMap');
      rounds.push({ gap, bound: windowMap[windowId] === ids.r3, live: live.length === 6 && live.every((u) => own(u, 'r3')), saved: await clean(), count: live.length });
      await call('openWorkspace', { id: ids.r1, windowId });
      await sleep(1500);
    }
    await chrome.windows.remove(windowId);
    for (const n of names) await call('deleteWorkspace', { id: ids[n] });
    return [{ name: 'clicking workspaces faster than a switch completes ends on the last one, nothing mixed', ok: rounds.every((r) => r.bound && r.live && r.saved), detail: JSON.stringify(rounds) }];
  })()`);
}

/** Closing a list of tabs where one already closed by itself (a login page, say) still closes the others. */
function closeTabsCheck(dash) {
  return dash.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = await chrome.windows.create({ url: [1, 2, 3, 4].map((n) => 'https://example.com/?close' + n), focused: false });
    await sleep(1000);
    const tabs = (await chrome.tabs.query({ windowId: w.id })).filter((t) => (t.pendingUrl || t.url).includes('?close'));
    await chrome.tabs.remove(tabs[1].id);
    const { closeTabs } = await import('/src/background/tabs.js');
    await closeTabs(tabs.map((t) => t.id));
    await sleep(300);
    const left = (await chrome.tabs.query({ windowId: w.id })).filter((t) => (t.pendingUrl || t.url).includes('?close')).length;
    await chrome.windows.remove(w.id).catch(() => {});
    return [{ name: 'closing tabs goes on past one already gone', ok: left === 0, detail: JSON.stringify({ left }) }];
  })()`);
}

/** Drops an open tab onto another workspace's card in the dashboard rack and checks it moved there. */
function dropOnCardCheck(cdp) {
  return cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { state } = await chrome.storage.local.get('state');
    const { windowMap } = await chrome.storage.session.get('windowMap');
    const byName = (n) => Object.values(state.workspaces).find((w) => w.name === n);
    const winOf = (id) => Number(Object.keys(windowMap).find((k) => windowMap[k] === id));
    const target = byName('Drag from');
    const tab = await chrome.tabs.create({ windowId: winOf(byName('Drag to').id), url: 'https://example.com/?dropped', active: false });
    location.hash = '#/ws/' + byName('Drag to').id;
    await sleep(900);
    const card = [...document.querySelectorAll('.ws-chip')].find((c) => c.title === target.name);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-ow-tab', JSON.stringify({ tabId: tab.id, url: 'https://example.com/?dropped' }));
    for (const type of ['dragover', 'drop']) card.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
    await sleep(1200);
    const moved = await chrome.tabs.get(tab.id).catch(() => null);
    return [{ name: 'tab dropped on a workspace card moves there', ok: moved?.windowId === winOf(target.id), detail: '' }];
  })()`);
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
  // Real pages, so the screenshots show real titles and favicons. The two pinned tabs stay in every workspace.
  const work = ws(1, 'Work', '💼', '#6366f1', {
    tabs: [
      tab('https://mail.google.com/', 'Gmail', { pinned: true }),
      tab('https://www.youtube.com/', 'YouTube', { pinned: true }),
      tab('https://github.com/trending', 'Trending repositories on GitHub today', { active: true, groupKey: 'g1' }),
      tab('https://developer.chrome.com/docs/extensions', 'Chrome Extensions', { groupKey: 'g1' }),
      tab('https://linear.app/changelog', 'Changelog - Linear'),
      tab('https://news.ycombinator.com/', 'Hacker News'),
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
  // An uploaded image as the workspace icon (the UI stores uploads as small PNGs; an SVG keeps the demo readable).
  const vinyl = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="44" fill="#111"/><circle cx="48" cy="48" r="34" fill="none" stroke="#333" stroke-width="2"/><circle cx="48" cy="48" r="26" fill="none" stroke="#2a2a2a" stroke-width="2"/><circle cx="48" cy="48" r="15" fill="#f97316"/><circle cx="48" cy="48" r="3" fill="#111"/></svg>`;
  const music = ws(5, 'Music', '', '#22c55e', { image: `data:image/svg+xml;base64,${Buffer.from(vinyl).toString('base64')}`, tabs: [tab('https://open.spotify.com/', 'Spotify')] });
  const client = ws(6, 'Client Acme', '', '#eab308', { tabs: [tab('https://www.figma.com/', 'Figma')] });
  const list = [work, side, travel, reading, music, client];
  return { order: list.map((w) => w.id), workspaces: Object.fromEntries(list.map((w) => [w.id, w])), settings: {} };
}

/**
 * Opens the demo workspace for real in its own window, then screenshots every surface from inside it.
 * SCREENSHOTS=1 writes the README set to docs/screenshots; any other value is a folder for the full
 * design-validation set (several widths, both themes, modal and empty states).
 */
async function captureScreens(port, extId, dir, dash, full) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const ext = (path) => `chrome-extension://${extId}/src/${path}`;

  const demoWin = await dash.eval(`(async () => {
    const call = (action, payload) => chrome.runtime.sendMessage({ type: 'ow:call', action, payload });
    await call('updateSettings', { patch: { lazyLoadTabs: false, suspend: { mode: 'manual' } } });
    const win = await chrome.windows.create({ focused: true, width: 1440, height: 900 });
    await call('openWorkspace', { id: 'demo-1', windowId: win.id });
    return win.id;
  })()`);
  await sleep(9000); // let the real pages load their titles and favicons

  const attach = async (match) => {
    for (let i = 0; i < 40; i++) {
      const target = (await getJson(port, '/json/list')).find((x) => x.type === 'page' && match(x.url));
      if (target) {
        const cdp = new Cdp(target.webSocketDebuggerUrl);
        await cdp.ready;
        return { cdp, target };
      }
      await sleep(150);
    }
    throw new Error('screenshot target not found');
  };
  const openInDemo = async (path) => {
    const url = ext(path);
    const tabId = await dash.eval(`chrome.tabs.create({ windowId: ${demoWin}, url: ${JSON.stringify(url)} }).then((t) => t.id)`);
    const { cdp, target } = await attach((u) => u === url);
    return { cdp, target, close: () => dash.eval(`chrome.tabs.remove(${tabId})`) };
  };
  // Every window has a home tab; tag the one we want with a hash so its DevTools target can be told apart.
  const homeOf = async (windowId) => {
    const url = `${ext('home/home.html')}#shot-${windowId}`;
    await dash.eval(`chrome.tabs.query({ windowId: ${windowId} }).then(async (tabs) => {
      const home = tabs.find((t) => t.url.startsWith(chrome.runtime.getURL('src/home/home.html')));
      await chrome.tabs.update(home.id, { url: ${JSON.stringify(url)}, active: true });
    })`);
    const { cdp, target } = await attach((u) => u === url);
    return { cdp, target, close: async () => {} };
  };
  const dashWin = await dash.eval('chrome.windows.getCurrent().then((w) => w.id)');

  const readme = [
    { name: 'home', home: demoWin, w: 1280, h: 800 },
    { name: 'home-resources', home: demoWin, w: 1280, h: 800, view: 'resources' },
    { name: 'dashboard', path: 'dashboard/dashboard.html#/ws/demo-2', w: 1280, h: 800 },
    { name: 'popup', path: 'popup/popup.html', w: 360, h: 560 },
    { name: 'sidepanel', path: 'sidepanel/sidepanel.html', w: 400, h: 760, view: 'resources' },
    { name: 'settings', path: 'dashboard/dashboard.html#/settings', w: 1280, h: 1000 },
  ];
  const validation = [
    ...[1440, 768, 375].map((w) => ({ name: `home-${w}`, home: demoWin, w, h: w === 375 ? 812 : w === 768 ? 1024 : 900 })),
    ...[1440, 768, 375].map((w) => ({ name: `dashboard-${w}`, path: 'dashboard/dashboard.html#/ws/demo-2', w, h: w === 375 ? 812 : w === 768 ? 1024 : 900 })),
    { name: 'home-resources-1440', home: demoWin, w: 1440, h: 900, view: 'resources' },
    { name: 'home-tasks-1440', home: demoWin, w: 1440, h: 900, view: 'tasks' },
    { name: 'home-unsaved-1440', home: dashWin, w: 1440, h: 900 },
    { name: 'settings-1440', path: 'dashboard/dashboard.html#/settings', w: 1440, h: 1700 },
    { name: 'popup', path: 'popup/popup.html', w: 360, h: 580 },
    { name: 'popup-search', path: 'popup/popup.html', w: 360, h: 580, type: 'git' },
    { name: 'popup-pin', path: 'popup/popup.html', w: 360, h: 360, pin: true },
    { name: 'sidepanel', path: 'sidepanel/sidepanel.html', w: 400, h: 800 },
    { name: 'sidepanel-resources', path: 'sidepanel/sidepanel.html', w: 400, h: 800, view: 'resources' },
    { name: 'form-1440', home: demoWin, w: 1440, h: 900, click: '.sidebar .sw-field' },
    { name: 'menu-1440', home: demoWin, w: 1440, h: 900, click: '.sidebar .sw-head .icon-btn' },
    { name: 'chip-menu-1440', home: demoWin, w: 1440, h: 900, click: '.rack .ws-chip:nth-child(2) .chip-menu .icon-btn' },
    { name: 'chip-menu-375', home: demoWin, w: 375, h: 812, click: '.rack .ws-chip:nth-child(1) .chip-menu .icon-btn' },
  ];

  for (const dark of [false, true]) {
    for (const shot of full ? validation : readme) {
      const page = shot.home != null ? await homeOf(shot.home) : await openInDemo(shot.path);
      const { cdp } = page;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: shot.w, height: shot.h, deviceScaleFactor: 2, mobile: false });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      await cdp.eval(`localStorage.setItem('ow:view', ${JSON.stringify(shot.view ?? 'tabs')})`).catch(() => {});
      // The pin question needs an unpinned always-on site to ask about.
      const pinTabId = shot.pin
        ? await dash.eval(`(async () => {
            const tab = await chrome.tabs.create({ windowId: ${demoWin}, url: 'https://web.whatsapp.com/', active: false });
            await new Promise((done) => setTimeout(done, 1500));
            await chrome.storage.session.set({ popupIntent: { kind: 'pin', tabId: tab.id, siteId: 'whatsapp' } });
            return tab.id;
          })()`)
        : null;
      await cdp.send('Page.reload');
      await sleep(1500);
      if (shot.type) {
        await cdp.eval(`(() => { const i = document.querySelector('.popup-search input'); i.focus(); document.execCommand('insertText', false, ${JSON.stringify(shot.type)}); })()`);
        await sleep(400);
      }
      if (shot.click) {
        await cdp.eval(`document.querySelector(${JSON.stringify(shot.click)})?.click()`);
        await sleep(500);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, `${shot.name}${dark ? '-dark' : ''}.png`), Buffer.from(data, 'base64'));
      if (pinTabId) await dash.eval(`chrome.tabs.remove(${pinTabId})`);
      if (full && !dark && shot.w === 1440 && !shot.click) {
        // Keep the rendered page as a standalone file for the design-quality scan.
        const htmlDoc = await cdp.eval(`(async () => {
          const css = (await Promise.all([...document.styleSheets].map((s) => s.href ? fetch(s.href).then((r) => r.text()) : s.ownerNode.textContent))).join('\\n');
          return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + document.body.innerHTML + '</body></html>';
        })()`);
        writeFileSync(join(dir, '..', `preview-${shot.name.replace(/-1440$/, '')}.html`), htmlDoc);
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      cdp.close();
      await page.close();
    }
  }
  if (full) {
    // The home tab icon for every demo workspace, side by side at tab-strip sizes.
    const page = await homeOf(demoWin);
    const sheet = await page.cdp.eval(`(async () => {
      const { workspaceFavicon } = await import('../ui/components.js');
      const { state } = await chrome.storage.local.get('state');
      const icons = await Promise.all(state.order.map((id) => workspaceFavicon(state.workspaces[id])));
      const canvas = Object.assign(document.createElement('canvas'), { width: 40 + icons.length * 120, height: 140 });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#dee1e6';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const [i, src] of icons.entries()) {
        const img = new Image();
        img.src = src;
        await img.decode();
        ctx.drawImage(img, 20 + i * 120, 20, 64, 64);
        ctx.drawImage(img, 20 + i * 120 + 76, 20, 32, 32);
        ctx.drawImage(img, 20 + i * 120 + 76, 64, 16, 16);
      }
      return canvas.toDataURL('image/png');
    })()`);
    writeFileSync(join(dir, 'home-tab-icons.png'), Buffer.from(sheet.split(',')[1], 'base64'));
    page.cdp.close();
  }
  console.log(`screenshots saved to ${dir}`);
}

async function main() {
  const browser = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'ow-smoke-'));
  const pinSite = await startPinSite(profile);
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
    ...(pinSite ? [`--host-resolver-rules=MAP web.whatsapp.com 127.0.0.1:${pinSite.address().port}`, '--ignore-certificate-errors'] : []),
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
    checks.push(...(await dropOnCardCheck(pages.dashboard)));
    const fixtureImage = `data:image/png;base64,${readFileSync(resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'icon.png')).toString('base64')}`;
    for (const [mode, image] of [['throttled', fixtureImage], ['frozen', '']]) checks.push(...(await backgroundIconCheck(port, pages.dashboard, mode, image)));
    for (const file of ['icon.png', 'icon.ico']) checks.push(...(await uploadCheck(pages.dashboard, resolve(import.meta.dirname, '..', 'tests', 'fixtures', file))));

    for (const name of ['dashboard', 'popup', 'sidepanel']) {
      const rendered = await pages[name].eval(`document.getElementById('app').children.length > 0 && document.body.innerText.length > 20`);
      checks.push({ name: `${name} page renders`, ok: rendered, detail: '' });
    }
    const dashText = await pages.dashboard.eval('document.body.innerText');
    checks.push({ name: 'dashboard lists workspaces', ok: dashText.includes('Alpha') && dashText.includes('Beta'), detail: dashText.slice(0, 200) });
    checks.push(...(await popupUploadCheck(port, pages.popup, pages.dashboard)));
    checks.push(...(await keepAliveCheck(port, pages.dashboard)));
    checks.push(...(await warmCheck(port, pages.dashboard)));
    checks.push(...(await parkedGroupNameCheck(pages.dashboard)));
    checks.push(...(await rapidSwitchCheck(pages.dashboard)));
    checks.push(...(await closeTabsCheck(pages.dashboard)));
    checks.push(...(await homeOnSwitchCheck(pages.dashboard)));
    if (pinSite) checks.push(...(await pinSuggestCheck(port, pages.dashboard)));
    else console.log('note: openssl not found, pin suggestion checks skipped');

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
      const full = process.env.SCREENSHOTS !== '1';
      await captureScreens(port, extId, resolve(full ? process.env.SCREENSHOTS : 'docs/screenshots'), pages.dashboard, full);
    }
    for (const cdp of Object.values(pages)) cdp.close();
    swCdp.close();
  } catch (err) {
    console.error(err);
  } finally {
    proc.kill();
    pinSite?.close();
    await sleep(800);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
  process.exit(exitCode);
}

main();
