// Low-level tab plumbing: snapshotting a window into its workspace and restoring a
// workspace's tabs into a window.

import { getState, mutate, workspaceForWindow } from './store.js';
import { isNewTabUrl, serializeGroup, serializeTab } from '../shared/model.js';

const SNAPSHOT_DELAY_MS = 400;
const timers = new Map();
/** Windows we're rewriting right now. Tab events from them are ignored until we finish. */
const busyWindows = new Set();

export const isBusy = (windowId) => busyWindows.has(windowId);

/** Marks `windowId` busy while `fn` runs, so the intermediate tab churn isn't saved. */
export async function withBusyWindow(windowId, fn) {
  busyWindows.add(windowId);
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

  const groups = chrome.tabGroups ? await chrome.tabGroups.query({ windowId }).catch(() => []) : [];
  const nextTabs = tabs.map(serializeTab);
  const used = new Set(nextTabs.map((t) => t.groupKey).filter(Boolean));
  const nextGroups = groups.map(serializeGroup).filter((g) => used.has(g.key));

  const current = (await getState()).workspaces[wsId];
  if (!current) return;
  if (JSON.stringify(current.tabs) === JSON.stringify(nextTabs) && JSON.stringify(current.groups) === JSON.stringify(nextGroups)) return;

  await mutate((state) => {
    const ws = state.workspaces[wsId];
    if (!ws) return;
    ws.tabs = nextTabs;
    ws.groups = nextGroups;
    ws.updatedAt = Date.now();
  });
}

/**
 * Re-creates the saved tabs of `ws` at the end of `windowId`.
 * @returns {Promise<number[]>} ids of tabs that should be lazily discarded once they commit a URL.
 */
export async function restoreTabs(windowId, ws, { lazy = true } = {}) {
  const list = ws.tabs.length ? ws.tabs : [{ url: '', pinned: false, active: true, groupKey: null }];
  let activeIndex = list.findIndex((t) => t.active);
  if (activeIndex < 0) activeIndex = Math.max(0, list.findIndex((t) => !t.pinned));

  const created = [];
  for (const [i, src] of list.entries()) {
    const props = { windowId, active: i === activeIndex, pinned: !!src.pinned };
    if (!isNewTabUrl(src.url)) props.url = src.url;
    try {
      const tab = await chrome.tabs.create(props);
      created.push({ id: tab.id, src, active: props.active, hasUrl: !!props.url });
    } catch (err) {
      // Some URLs can't be opened by extensions (e.g. file:// without access). Skip them.
      console.warn('[open-workspaces] could not restore tab', src.url, err);
    }
  }
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

export async function lastFocusedNormalWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return win?.type === 'normal' ? win.id : null;
  } catch {
    return null;
  }
}
