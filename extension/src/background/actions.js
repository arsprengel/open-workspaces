// Every operation the UI can request. Each handler receives a plain object and returns
// JSON-serializable data. Wired to chrome.runtime.onMessage in service-worker.js.

import { clearWindowMap, getState, getWindowMap, mutate, replaceState, setWindowWorkspace, unbindWorkspace, windowForWorkspace, workspaceForWindow } from './store.js';
import { discardWhenReady, ensureHomeTab, lastFocusedNormalWindow, restoreTabs, snapshotWindow, withBusyWindow } from './tabs.js';
import {
  closeParked, dropParkedRecord, getMarks, getParked, markTabs, parkTabs, parkedOf, tidyParkedGroups, unregisterParked,
} from './keep-alive.js';
import {
  applyImport, buildExport, cleanImage, isNewTabUrl, isWindowFixture, keepAliveMatches, makeSection, makeWorkspace, matchWindows,
  pairParked, serializeTab, uid,
} from '../shared/model.js';

const ws404 = (id) => new Error(`workspace-not-found:${id}`);

function requireWs(state, id) {
  const ws = state.workspaces[id];
  if (!ws) throw ws404(id);
  return ws;
}

function findSection(ws, sectionId) {
  return ws.sections.find((s) => s.id === sectionId) ?? ws.sections[0];
}

// ---------------------------------------------------------------------------
// Workspaces

export async function createWorkspace({ name = '', icon = '', image = '', color, fromWindowId = null, open = false, windowId = null } = {}) {
  const ws = await mutate((state) => {
    const created = makeWorkspace({ name: name.trim(), icon, image: cleanImage(image), ...(color ? { color } : {}) }, state.order.length);
    state.workspaces[created.id] = created;
    state.order.push(created.id);
    return created;
  });
  if (fromWindowId != null) {
    await setWindowWorkspace(fromWindowId, ws.id);
    await snapshotWindow(fromWindowId);
    await touchOpened(ws.id);
  } else if (open) {
    await openWorkspace({ id: ws.id, windowId });
  }
  return { id: ws.id };
}

export async function updateWorkspace({ id, patch }) {
  const allowed = ['name', 'icon', 'color'];
  await mutate((state) => {
    const ws = requireWs(state, id);
    for (const key of allowed) if (typeof patch[key] === 'string') ws[key] = key === 'name' ? patch[key].trim() : patch[key];
    if (typeof patch.image === 'string') ws.image = cleanImage(patch.image);
    ws.updatedAt = Date.now();
  });
}

export async function duplicateWorkspace({ id }) {
  return mutate((state) => {
    const src = requireWs(state, id);
    const copy = structuredClone(src);
    copy.id = uid();
    copy.name = `${src.name} (2)`.trim();
    copy.createdAt = copy.updatedAt = Date.now();
    copy.lastOpenedAt = 0;
    for (const s of copy.sections) {
      s.id = uid();
      for (const i of s.items) i.id = uid();
    }
    for (const t of copy.tasks) t.id = uid();
    state.workspaces[copy.id] = copy;
    state.order.splice(state.order.indexOf(id) + 1, 0, copy.id);
    return { id: copy.id };
  });
}

/** Deletes the workspace. If it's open, its window stays open as an unsaved window; kept-alive tabs waiting for it close. */
export async function deleteWorkspace({ id }) {
  await unbindWorkspace(id);
  await mutate((state) => {
    delete state.workspaces[id];
    state.order = state.order.filter((x) => x !== id);
  });
  await closeParked((_tabId, p) => p.wsId === id);
  await dropParkedRecord(id);
}

export async function setArchived({ id, archived }) {
  if (archived) await closeWorkspace({ id });
  await mutate((state) => {
    requireWs(state, id).archived = !!archived;
  });
}

export async function reorderWorkspaces({ order }) {
  await mutate((state) => {
    const known = new Set(state.order);
    const next = order.filter((id) => known.has(id));
    for (const id of state.order) if (!next.includes(id)) next.push(id);
    state.order = next;
  });
}

async function touchOpened(id) {
  await mutate((state) => {
    if (state.workspaces[id]) state.workspaces[id].lastOpenedAt = Date.now();
  });
}

/**
 * Opens (switches to) a workspace.
 * - Already open in some window: focus that window.
 * - openMode "current" and the target window is a workspace or only has blank tabs: swap its tabs.
 * - Otherwise (new window requested, or the window has unsaved tabs we must not lose): new window.
 */
export async function openWorkspace({ id, windowId = null, newWindow = false }) {
  const state = await getState();
  const ws = requireWs(state, id);

  const existing = await windowForWorkspace(id);
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return { windowId: existing };
    } catch {
      await setWindowWorkspace(existing, null); // stale mapping
    }
  }

  if (ws.archived) await mutate((s) => (requireWs(s, id).archived = false));

  const target = windowId ?? (await lastFocusedNormalWindow());
  if (!newWindow && state.settings.openMode === 'current' && target != null) {
    const currentWsId = await workspaceForWindow(target);
    const currentTabs = await chrome.tabs.query({ windowId: target });
    const keepPinned = state.settings.keepPinned;
    const parked = await getParked();
    const hasUnsavedTabs = !currentWsId && currentTabs.some((t) => !isNewTabUrl(t.pendingUrl || t.url) && !isWindowFixture(t, keepPinned, parked));
    if (!hasUnsavedTabs) return swapWindow(target, id, currentTabs, currentWsId);
  }
  return openInNewWindow(id);
}

async function swapWindow(windowId, wsId, oldTabs, oldWsId) {
  if (oldWsId) await snapshotWindow(windowId);
  const { settings, workspaces } = await getState();
  const ws = workspaces[wsId];
  // Read before restoring: the new workspace's own parked tabs are part of oldTabs and must not leave.
  const parked = await getParked();
  const lazyIds = await withBusyWindow(windowId, async () => {
    await setWindowWorkspace(windowId, wsId);
    const ids = await restoreTabs(windowId, ws, { lazy: settings.lazyLoadTabs, keepPinned: settings.keepPinned });
    // The home tab, kept pinned tabs and other workspaces' parked tabs belong to the window, so they survive the swap.
    const leaving = oldTabs.filter((t) => !isWindowFixture(t, settings.keepPinned, parked));
    // Tabs marked to keep running wait in a collapsed group instead of closing (pinned tabs can't be grouped).
    const marks = await getMarks();
    const keptAlive = new Set(await parkTabs(oldWsId && workspaces[oldWsId], leaving.filter((t) => marks[t.id] && !t.pinned)));
    const closing = leaving.filter((t) => !keptAlive.has(t.id)).map((t) => t.id);
    if (closing.length) await chrome.tabs.remove(closing).catch(() => {});
    await tidyParkedGroups(windowId);
    if (settings.homeTab) await ensureHomeTab(windowId, { refresh: true });
    return ids;
  });
  await touchOpened(wsId);
  await snapshotWindow(windowId);
  discardWhenReady(lazyIds);
  return { windowId };
}

async function openInNewWindow(wsId) {
  const { settings, workspaces } = await getState();
  const ws = workspaces[wsId];
  const win = await chrome.windows.create({ focused: true });
  const lazyIds = await withBusyWindow(win.id, async () => {
    const initial = win.tabs?.length ? win.tabs : await chrome.tabs.query({ windowId: win.id });
    await setWindowWorkspace(win.id, wsId);
    const ids = await restoreTabs(win.id, ws, { lazy: settings.lazyLoadTabs, keepPinned: settings.keepPinned });
    await chrome.tabs.remove(initial.map((t) => t.id)).catch(() => {});
    if (settings.homeTab) await ensureHomeTab(win.id);
    return ids;
  });
  await touchOpened(wsId);
  await snapshotWindow(win.id);
  discardWhenReady(lazyIds);
  return { windowId: win.id };
}

/** Saves and closes a workspace's tabs. The last browser window is kept alive with a new tab. */
export async function closeWorkspace({ id }) {
  const windowId = await windowForWorkspace(id);
  if (windowId == null) return;
  await snapshotWindow(windowId);
  await setWindowWorkspace(windowId, null);
  const normals = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (normals.length > 1) {
    await chrome.windows.remove(windowId).catch(() => {});
    return;
  }
  const { settings } = await getState();
  const parked = await getParked();
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => !isWindowFixture(t, settings.keepPinned, parked));
  await chrome.tabs.create({ windowId, active: true });
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
}

/** Cycles through open-able (non archived) workspaces in sidebar order. */
export async function cycleWorkspace({ direction = 1, windowId = null } = {}) {
  const state = await getState();
  const ids = state.order.filter((id) => !state.workspaces[id].archived);
  if (!ids.length) return;
  const win = windowId ?? (await lastFocusedNormalWindow());
  const current = win != null ? await workspaceForWindow(win) : null;
  const index = current ? ids.indexOf(current) : -1;
  const next = ids[(index + direction + ids.length) % ids.length];
  if (next !== current) await openWorkspace({ id: next, windowId: win });
}

// ---------------------------------------------------------------------------
// Tabs

/** Moves tabs into another workspace: into its window if open, else into its saved tabs. */
export async function moveTabs({ tabIds, targetId }) {
  if (!tabIds?.length) return;
  const targetWindow = await windowForWorkspace(targetId);
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  if (!tabs.length) return;

  await unregisterParked(tabs.map((t) => t.id));
  if (targetWindow != null) {
    const toMove = tabs.filter((t) => t.windowId !== targetWindow).map((t) => t.id);
    if (toMove.length) {
      await keepWindowsAlive(tabs);
      await chrome.tabs.move(toMove, { windowId: targetWindow, index: -1 });
    }
    return;
  }

  const marks = await getMarks();
  await mutate((state) => {
    const ws = requireWs(state, targetId);
    if (ws.tabs.every((t) => isNewTabUrl(t.url))) ws.tabs = [];
    ws.tabs.push(...tabs.map((t) => ({ ...serializeTab(t, !!marks[t.id]), active: false, pinned: false, groupKey: null })));
    ws.updatedAt = Date.now();
  });
  await keepWindowsAlive(tabs);
  await chrome.tabs.remove(tabs.map((t) => t.id));
}

/** If removing `tabs` would empty a window, open a blank tab there first so the window survives. */
async function keepWindowsAlive(tabs) {
  const byWindow = new Map();
  for (const t of tabs) byWindow.set(t.windowId, (byWindow.get(t.windowId) ?? 0) + 1);
  for (const [windowId, count] of byWindow) {
    const all = await chrome.tabs.query({ windowId });
    if (all.length <= count) await chrome.tabs.create({ windowId, active: true });
  }
}

/** Removes one saved tab from a workspace that isn't open (and closes it if it's kept running meanwhile). */
export async function removeSavedTab({ wsId, index }) {
  const parked = await parkedOf(wsId);
  const removed = await mutate((state) => {
    const ws = requireWs(state, wsId);
    const tabId = pairParked(ws.tabs, parked).byIndex.get(index);
    ws.tabs.splice(index, 1);
    return tabId;
  });
  if (removed != null) await closeParked((tabId) => tabId === removed);
}

/** Marks a tab to keep running while its workspace is closed (or unmarks it). */
export async function setKeepAlive({ tabId, keep }) {
  const tab = await chrome.tabs.get(tabId);
  await markTabs([tabId], !!keep);
  await snapshotWindow(tab.windowId);
}

// ---------------------------------------------------------------------------
// Resources (saved links organised in sections)

export async function addResources({ wsId, sectionId = null, items }) {
  await mutate((state) => {
    const ws = requireWs(state, wsId);
    const section = findSection(ws, sectionId);
    const known = new Set(section.items.map((i) => i.url));
    for (const item of items) {
      if (!item.url || isNewTabUrl(item.url) || known.has(item.url)) continue;
      known.add(item.url);
      section.items.push({ id: uid(), url: item.url, title: item.title || item.url, addedAt: Date.now() });
    }
  });
}

/** Saves tabs (by id) as resources. */
export async function saveTabsAsResources({ wsId, tabIds, sectionId = null }) {
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  await addResources({ wsId, sectionId, items: tabs.map((t) => ({ url: t.pendingUrl || t.url, title: t.title })) });
}

export async function updateResource({ wsId, itemId, patch }) {
  await mutate((state) => {
    for (const s of requireWs(state, wsId).sections) {
      const item = s.items.find((i) => i.id === itemId);
      if (!item) continue;
      if (typeof patch.title === 'string') item.title = patch.title;
      if (typeof patch.url === 'string' && patch.url) item.url = patch.url;
    }
  });
}

export async function removeResource({ wsId, itemId }) {
  await mutate((state) => {
    for (const s of requireWs(state, wsId).sections) s.items = s.items.filter((i) => i.id !== itemId);
  });
}

/** Moves a resource to another section (possibly in another workspace) at a given index. */
export async function moveResource({ wsId, itemId, toWsId = wsId, toSectionId, toIndex = -1 }) {
  await mutate((state) => {
    let item = null;
    for (const s of requireWs(state, wsId).sections) {
      const i = s.items.findIndex((x) => x.id === itemId);
      if (i >= 0) [item] = s.items.splice(i, 1);
    }
    if (!item) return;
    const section = findSection(requireWs(state, toWsId), toSectionId);
    const index = toIndex < 0 || toIndex > section.items.length ? section.items.length : toIndex;
    section.items.splice(index, 0, item);
  });
}

export async function addSection({ wsId, name = '' }) {
  return mutate((state) => {
    const section = makeSection(name.trim());
    requireWs(state, wsId).sections.push(section);
    return { id: section.id };
  });
}

export async function updateSection({ wsId, sectionId, patch }) {
  await mutate((state) => {
    const section = requireWs(state, wsId).sections.find((s) => s.id === sectionId);
    if (!section) return;
    if (typeof patch.name === 'string') section.name = patch.name.trim();
    if (typeof patch.collapsed === 'boolean') section.collapsed = patch.collapsed;
  });
}

/** Removes a section. Its links move to the first remaining section unless `dropItems`. */
export async function removeSection({ wsId, sectionId, dropItems = false }) {
  await mutate((state) => {
    const ws = requireWs(state, wsId);
    const index = ws.sections.findIndex((s) => s.id === sectionId);
    if (index < 0) return;
    const [removed] = ws.sections.splice(index, 1);
    if (!ws.sections.length) ws.sections.push(makeSection());
    if (!dropItems) ws.sections[0].items.push(...removed.items);
  });
}

export async function moveSection({ wsId, sectionId, toIndex }) {
  await mutate((state) => {
    const ws = requireWs(state, wsId);
    const from = ws.sections.findIndex((s) => s.id === sectionId);
    if (from < 0) return;
    const [section] = ws.sections.splice(from, 1);
    ws.sections.splice(Math.max(0, Math.min(toIndex, ws.sections.length)), 0, section);
  });
}

// ---------------------------------------------------------------------------
// Notes & tasks

export async function setNotes({ wsId, notes }) {
  await mutate((state) => {
    requireWs(state, wsId).notes = String(notes);
  });
}

export async function addTask({ wsId, text }) {
  if (!text?.trim()) return;
  await mutate((state) => {
    requireWs(state, wsId).tasks.push({ id: uid(), text: text.trim(), done: false, createdAt: Date.now() });
  });
}

export async function updateTask({ wsId, taskId, patch }) {
  await mutate((state) => {
    const task = requireWs(state, wsId).tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (typeof patch.text === 'string') task.text = patch.text;
    if (typeof patch.done === 'boolean') task.done = patch.done;
  });
}

export async function removeTask({ wsId, taskId }) {
  await mutate((state) => {
    const ws = requireWs(state, wsId);
    ws.tasks = ws.tasks.filter((t) => t.id !== taskId);
  });
}

export async function clearDoneTasks({ wsId }) {
  await mutate((state) => {
    const ws = requireWs(state, wsId);
    ws.tasks = ws.tasks.filter((t) => !t.done);
  });
}

// ---------------------------------------------------------------------------
// Settings, backup

export async function updateSettings({ patch }) {
  await mutate((state) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in state.settings)) continue;
      state.settings[key] = typeof value === 'object' && value !== null ? { ...state.settings[key], ...value } : value;
    }
  });
}

export async function exportData() {
  // Make sure open windows are saved before exporting.
  for (const windowId of Object.keys(await getWindowMap())) await snapshotWindow(Number(windowId));
  return buildExport(await getState());
}

export async function importData({ data, mode = 'merge' }) {
  const next = applyImport(await getState(), data, mode);
  if (mode === 'replace') await clearWindowMap();
  await replaceState(next);
  // Kept-alive tabs waiting for workspaces that no longer exist have nowhere to go back to.
  await closeParked((_tabId, p) => !next.workspaces[p.wsId]);
  return { count: Object.keys(next.workspaces).length };
}

// ---------------------------------------------------------------------------
// Window reconciliation (after a browser restart or when a closed window is reopened)

export async function reconcileWindows({ onlyWindowId = null } = {}) {
  const state = await getState();
  const map = await getWindowMap();
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const alive = new Set(windows.map((w) => w.id));

  for (const win of Object.keys(map)) if (!alive.has(Number(win))) await setWindowWorkspace(Number(win), null);

  const boundWs = new Set(Object.values(await getWindowMap()));
  const parked = await getParked();
  const own = (w) => (w.tabs ?? []).filter((t) => !isWindowFixture(t, state.settings.keepPinned, parked));
  const candidates = windows
    .filter((w) => !(w.id in map) && (onlyWindowId == null || w.id === onlyWindowId))
    .map((w) => ({ id: w.id, urls: own(w).map((t) => t.pendingUrl || t.url) }));
  const free = Object.values(state.workspaces)
    .filter((ws) => !boundWs.has(ws.id) && !ws.archived)
    .map((ws) => ({ id: ws.id, urls: ws.tabs.map((t) => t.url) }));

  for (const [windowId, wsId] of matchWindows(candidates, free)) {
    await setWindowWorkspace(windowId, wsId);
    // Tab ids changed since the marks were set: find the kept-alive tabs again by URL.
    const ids = keepAliveMatches(own(windows.find((w) => w.id === windowId)), state.workspaces[wsId].tabs);
    if (ids.length) await markTabs(ids);
  }
}
