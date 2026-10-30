// Low-level tab plumbing: snapshotting a window into its workspace and restoring a
// workspace's tabs into a window.

import { getState, mutate, workspaceForWindow } from './store.js';
import { isHomeUrl, isNewTabUrl, isWindowFixture, normalizeUrl, pairParked, serializeGroup, serializeTab } from '../shared/model.js';
import { getMarks, getParked, markTabs, takeParked, unparkTab } from './keep-alive.js';
import { HOME_PAGE } from '../shared/constants.js';

const SNAPSHOT_DELAY_MS = 400;
const timers = new Map();
/** Windows we're rewriting right now. Tab events from them are ignored until we finish. */
const busyWindows = new Set();
/** Bumped each time a window gets rewritten, so a snapshot that straddled it knows it's stale. */
const rewrites = new Map();

export const isBusy = (windowId) => busyWindows.has(windowId);

/** Marks `windowId` busy while `fn` runs, so the intermediate tab churn isn't saved. */
export async function withBusyWindow(windowId, fn) {
  busyWindows.add(windowId);
  rewrites.set(windowId, (rewrites.get(windowId) ?? 0) + 1);
  cancelSnapshot(windowId);
  try {
    return await fn();
  } finally {
    busyWindows.delete(windowId);
  }
}

export function cancelSnapshot(windowId) {
  clearTimeout(timers.get(windowId));
  timers.delete(windowId);
}

/** Debounced snapshot: many tab events in a burst become a single write. */
export function scheduleSnapshot(windowId) {
  if (typeof windowId !== 'number' || windowId < 0 || busyWindows.has(windowId)) return;
  cancelSnapshot(windowId);
  timers.set(
    windowId,
    setTimeout(() => {
      timers.delete(windowId);
      snapshotWindow(windowId).catch((err) => console.warn('[open-workspaces] snapshot failed', err));
    }, SNAPSHOT_DELAY_MS),
  );
}

/** Saves the current tabs (and tab groups) of `windowId` into the workspace bound to it. */
export async function snapshotWindow(windowId) {
  cancelSnapshot(windowId);
  if (busyWindows.has(windowId)) return;
  const rewrite = rewrites.get(windowId);
  const wsId = await workspaceForWindow(windowId);
  if (!wsId) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return; // window is gone
  }
  // A window that is closing reports zero tabs; never overwrite a workspace with nothing.
  if (!tabs.length) return;

  const { settings, workspaces } = await getState();
  const [marks, parked] = await Promise.all([getMarks(), getParked()]);
  const groups = chrome.tabGroups ? await chrome.tabGroups.query({ windowId }).catch(() => []) : [];
  const nextTabs = tabs.filter((tab) => !isWindowFixture(tab, settings.keepPinned, parked)).map((tab) => serializeTab(tab, !!marks[tab.id]));
  const used = new Set(nextTabs.map((t) => t.groupKey).filter(Boolean));
  const nextGroups = groups.map(serializeGroup).filter((g) => used.has(g.key));

  const current = workspaces[wsId];
  if (!current) return;
  if (JSON.stringify(current.tabs) === JSON.stringify(nextTabs) && JSON.stringify(current.groups) === JSON.stringify(nextGroups)) return;

  await mutate((state) => {
    // The window was rewritten (a workspace switch) while we read it: what we read is half old, half new.
    if (busyWindows.has(windowId) || rewrites.get(windowId) !== rewrite) return;
    const ws = state.workspaces[wsId];
    if (!ws) return;
    ws.tabs = nextTabs;
    ws.groups = nextGroups;
    ws.updatedAt = Date.now();
  });
}

/**
 * Re-creates the saved tabs of `ws` at the end of `windowId`. Kept-alive tabs still running in a parked
 * group (see keep-alive.js) are moved back instead, so they come back without a reload.
 * @returns {Promise<number[]>} ids of tabs that should be lazily discarded once they commit a URL.
 */
export async function restoreTabs(windowId, ws, { lazy = true, keepPinned = false } = {}) {
  // Pinned tabs saved before "keep pinned tabs" was on are restored once, unless the window already has them.
  const pinnedHere = keepPinned
    ? new Set((await chrome.tabs.query({ windowId, pinned: true }).catch(() => [])).map((t) => normalizeUrl(t.pendingUrl || t.url)))
    : new Set();
  const saved = ws.tabs.filter((t) => !isHomeUrl(t.url) && !(t.pinned && pinnedHere.has(normalizeUrl(t.url))));
  const list = saved.length ? saved : [{ url: '', pinned: false, active: true, groupKey: null }];
  let activeIndex = list.findIndex((t) => t.active);
  if (activeIndex < 0) activeIndex = Math.max(0, list.findIndex((t) => !t.pinned));

  const { byIndex, leftover } = pairParked(list, await takeParked(ws.id));
  const created = [];
  const keptAlive = [];
  for (const [i, src] of list.entries()) {
    const active = i === activeIndex;
    const parkedId = byIndex.get(i);
    if (parkedId != null && (await unparkTab(parkedId, windowId))) {
      if (active) await chrome.tabs.update(parkedId, { active: true }).catch(() => {});
      created.push({ id: parkedId, src, active, hasUrl: false });
      continue;
    }
    const props = { windowId, active, pinned: !!src.pinned };
    if (!isNewTabUrl(src.url)) props.url = src.url;
    try {
      const tab = await chrome.tabs.create(props);
      // A kept-alive tab is meant to run, so it loads right away instead of waiting for a click.
      created.push({ id: tab.id, src, active, hasUrl: !!props.url && !src.keepAlive });
      if (src.keepAlive) keptAlive.push(tab.id);
    } catch (err) {
      // Some URLs can't be opened by extensions (e.g. file:// without access). Skip them.
      console.warn('[open-workspaces] could not restore tab', src.url, err);
    }
  }
  // Parked tabs whose saved entry was removed meanwhile still come back rather than being lost.
  for (const tabId of leftover) {
    if (await unparkTab(tabId, windowId)) created.push({ id: tabId, src: { groupKey: null, pinned: false }, active: false, hasUrl: false });
  }
  if (keptAlive.length) await markTabs(keptAlive);
  if (!created.length) {
    const tab = await chrome.tabs.create({ windowId, active: true });
    created.push({ id: tab.id, src: list[0], active: true, hasUrl: false });
  }
  if (!created.some((c) => c.active)) await chrome.tabs.update(created[0].id, { active: true }).catch(() => {});

  await restoreGroups(windowId, ws, created);

  return lazy ? created.filter((c) => !c.active && c.hasUrl).map((c) => c.id) : [];
}

async function restoreGroups(windowId, ws, created) {
  if (!chrome.tabGroups) return;
  const byKey = new Map();
  for (const c of created) {
    if (!c.src.groupKey || c.src.pinned) continue;
    if (!byKey.has(c.src.groupKey)) byKey.set(c.src.groupKey, []);
    byKey.get(c.src.groupKey).push(c.id);
  }
  for (const [key, tabIds] of byKey) {
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      const meta = ws.groups.find((g) => g.key === key);
      if (meta) await chrome.tabGroups.update(groupId, { title: meta.title, color: meta.color, collapsed: meta.collapsed });
    } catch (err) {
      console.warn('[open-workspaces] could not restore tab group', err);
    }
  }
}

/**
 * Discards tabs as soon as they've committed their URL, so they show up with title and
 * favicon but don't use memory until clicked. Discarding before the commit would lose the URL.
 */
export function discardWhenReady(tabIds, timeoutMs = 8000) {
  if (!tabIds.length) return Promise.resolve();
  const pending = new Set(tabIds);
  return new Promise((resolve) => {
    const discard = (tabId) => {
      if (!pending.delete(tabId)) return;
      chrome.tabs.discard(tabId).catch(() => {});
      if (!pending.size) done();
    };
    const listener = (tabId, info, tab) => {
      if (!pending.has(tabId) || tab.active) return;
      if (info.url || (info.status && tab.url && !isNewTabUrl(tab.url))) discard(tabId);
    };
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(() => {
      for (const id of [...pending]) discard(id);
      done();
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // Tabs may have committed before the listener was attached.
    for (const id of tabIds) {
      chrome.tabs
        .get(id)
        .then((tab) => {
          if (tab.url && !isNewTabUrl(tab.url) && !tab.active) discard(id);
        })
        .catch(() => pending.delete(id));
    }
  });
}

export const homeUrl = () => chrome.runtime.getURL(HOME_PAGE);
const isOwnHome = (tab) => (tab.pendingUrl || tab.url || '').startsWith(homeUrl());

/**
 * Makes sure `windowId` has exactly one home tab, pinned at the far left. `refresh` is for a workspace
 * switch: the browser may have frozen the home tab in the background, and a frozen page can't change its icon.
 */
export async function ensureHomeTab(windowId, { refresh = false } = {}) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return; // window is gone
  }
  const [home, ...extra] = tabs.filter(isOwnHome);
  if (extra.length) await chrome.tabs.remove(extra.map((t) => t.id)).catch(() => {});
  try {
    if (!home) {
      await chrome.tabs.create({ windowId, url: homeUrl(), pinned: true, index: 0, active: false });
      return;
    }
    if (!home.pinned) await chrome.tabs.update(home.id, { pinned: true });
    if (home.index !== 0) await chrome.tabs.move(home.id, { index: 0 });
    // Its icon shows the window's workspace; a discarded or frozen tab would keep the old one until clicked.
    // Browsers before Chrome 132 don't say whether a tab is frozen, so there any background home tab reloads.
    if (home.discarded || (refresh && !home.active && home.frozen !== false)) await chrome.tabs.reload(home.id);
  } catch (err) {
    console.warn('[open-workspaces] home tab', err);
  }
}

/** Adds the home tab to every normal window, or removes it everywhere. */
export async function syncHomeTabs(enabled) {
  const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !w.incognito);
  if (enabled) {
    for (const win of windows) await withBusyWindow(win.id, () => ensureHomeTab(win.id));
    return;
  }
  const tabs = await chrome.tabs.query({});
  const homes = tabs.filter(isOwnHome);
  for (const win of windows) {
    // Don't let removing the home tab close a window that has nothing else.
    const own = tabs.filter((t) => t.windowId === win.id);
    if (own.length && own.every(isOwnHome)) await chrome.tabs.create({ windowId: win.id, active: true }).catch(() => {});
  }
  if (homes.length) await chrome.tabs.remove(homes.map((t) => t.id)).catch(() => {});
}

export async function lastFocusedNormalWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return win?.type === 'normal' ? win.id : null;
  } catch {
    return null;
  }
}
