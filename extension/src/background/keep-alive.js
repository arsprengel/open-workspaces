// Parked tabs: switching away from a workspace gathers its tabs in a collapsed tab group at the end of the
// window (untitled, so it shows as a small dot in the workspace's color) instead of closing them; opening the workspace takes them
// back out, in place and without a reload. Tabs the user marked to keep running wait for as long as it
// takes; the others only for a while (settings.warmMinutes), in case the switch was a quick look elsewhere.
// Marks and parked tabs are tab ids, so they live in storage.session. Each parked group's title and URLs
// are also kept in storage.local, to recognise the group once ids change (browser restart, extension update).

import { dueParked, nearestGroupColor, recognizeParked, reparkEntries } from '../shared/model.js';
import { KEEP_ALIVE_KEY, PARKED_GROUPS_KEY, PARKED_KEY } from '../shared/constants.js';

export const PARKED_ALARM = 'ow-parked';

let queue = Promise.resolve();

/** Read-modify-write of one storage key, one at a time, so a burst of tab events doesn't lose updates. */
function update(area, key, fn) {
  const run = queue.then(async () => {
    const value = (await chrome.storage[area].get(key))[key] ?? {};
    fn(value);
    await chrome.storage[area].set({ [key]: value });
    return value;
  });
  queue = run.catch(() => {});
  return run;
}

const read = async (area, key) => (await chrome.storage[area].get(key))[key] ?? {};

/** tabId -> true for every tab marked to keep running. */
export const getMarks = () => read('session', KEEP_ALIVE_KEY);
/** tabId -> {wsId, order, url, leftAt?} for every parked tab (see PARKED_KEY). */
export const getParked = () => read('session', PARKED_KEY);

export function markTabs(tabIds, keep = true) {
  return update('session', KEEP_ALIVE_KEY, (marks) => {
    for (const id of tabIds) {
      if (keep) marks[id] = true;
      else delete marks[id];
    }
  });
}

const pageOf = (tab) => tab.pendingUrl || tab.url;

/**
 * Gathers tabs leaving `ws` into a collapsed group at the end of their window. Those in `marks` wait until
 * the workspace opens again, the others only for a while. `orders` holds each tab's place in the workspace.
 * @returns {Promise<number[]>} the ids parked; empty if the browser refused (the caller closes them then).
 */
export async function parkTabs(ws, tabs, { marks = {}, orders = null } = {}) {
  if (!ws || !tabs.length || !chrome.tabGroups) return [];
  const ids = tabs.map((t) => t.id);
  try {
    const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: tabs[0].windowId } });
    await chrome.tabGroups.update(groupId, { title: '', color: nearestGroupColor(ws.color), collapsed: true });
    await chrome.tabGroups.move(groupId, { index: -1 });
  } catch (err) {
    console.warn('[open-workspaces] could not park tabs', err);
    return [];
  }
  // Memory saving may discard background tabs; marked ones are meant to keep running. The others it may
  // still free when memory runs low: they come back with a reload then.
  for (const id of ids) if (marks[id]) chrome.tabs.update(id, { autoDiscardable: false }).catch(() => {});
  const leftAt = Date.now();
  await update('session', PARKED_KEY, (parked) =>
    tabs.forEach((t, i) => (parked[t.id] = { wsId: ws.id, order: orders?.[i] ?? i, url: pageOf(t), ...(!marks[t.id] && { leftAt }) })),
  );
  const kept = tabs.filter((t) => marks[t.id]).map(pageOf);
  await update('local', PARKED_GROUPS_KEY, (groups) => (groups[ws.id] = { title: '', urls: tabs.map(pageOf), kept }));
  return ids;
}

/** The parked tabs of `wsId` (`{tabId, order, url}`), dropped from the registry: the caller brings them back. */
export async function takeParked(wsId) {
  const taken = [];
  await update('session', PARKED_KEY, (parked) => {
    for (const [id, p] of Object.entries(parked)) {
      if (p.wsId !== wsId) continue;
      taken.push({ tabId: Number(id), order: p.order, url: p.url });
      delete parked[id];
    }
  });
  await update('local', PARKED_GROUPS_KEY, (groups) => delete groups[wsId]);
  return taken;
}

/** The parked tabs of `wsId` (`{tabId, order, url}`), left in place. */
export async function parkedOf(wsId) {
  return Object.entries(await getParked())
    .filter(([, p]) => p.wsId === wsId)
    .map(([id, p]) => ({ tabId: Number(id), order: p.order, url: p.url }));
}

/** Closes the tabs parked only for a while once they're due (see dueParked) and sets the alarm for the next. */
export async function expireParked(minutes) {
  const parked = await getParked();
  const waiting = Object.values(parked).some((p) => p.leftAt);
  const tabs = waiting ? (await chrome.tabs.query({})).filter((t) => parked[t.id]?.leftAt) : [];
  const { close, next } = dueParked(parked, tabs, minutes, Date.now());
  if (close.length) await closeParked((tabId) => close.includes(tabId));
  if (next == null) await chrome.alarms.clear(PARKED_ALARM);
  else await chrome.alarms.create(PARKED_ALARM, { when: next });
}

/** Moves a parked tab out of its group to the end of `windowId`. False if the tab is gone. */
export async function unparkTab(tabId, windowId) {
  try {
    await chrome.tabs.ungroup(tabId);
    await chrome.tabs.move(tabId, { windowId, index: -1 });
  } catch {
    return false;
  }
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  return true;
}

/** Closes parked tabs for which `pick(tabId, entry)` is true (e.g. those of a deleted workspace). */
export async function closeParked(pick) {
  const closing = [];
  const wsIds = new Set();
  const left = await update('session', PARKED_KEY, (parked) => {
    for (const [id, p] of Object.entries(parked)) {
      if (!pick(Number(id), p)) continue;
      closing.push(Number(id));
      wsIds.add(p.wsId);
      delete parked[id];
    }
  });
  for (const wsId of wsIds) if (!Object.values(left).some((p) => p.wsId === wsId)) await dropParkedRecord(wsId);
  if (closing.length) await chrome.tabs.remove(closing).catch(() => {});
}

/** Forgets the record of `wsId`'s parked group (its workspace is gone). */
export function dropParkedRecord(wsId) {
  return update('local', PARKED_GROUPS_KEY, (groups) => delete groups[wsId]);
}

/** Keeps a moved tab from being treated as parked any longer. */
export async function unregisterParked(tabIds) {
  const parked = await getParked();
  if (!tabIds.some((id) => parked[id])) return;
  await update('session', PARKED_KEY, (p) => tabIds.forEach((id) => delete p[id]));
}

/**
 * A tab closed. Its mark and parked entry go, but when its window is closing the parked group's record
 * stays: the browser may be quitting and bring the window back, group included, on the next start.
 */
export async function forgetTab(tabId, windowClosing = false) {
  const [marks, parked] = await Promise.all([getMarks(), getParked()]);
  if (marks[tabId]) await markTabs([tabId], false);
  const entry = parked[tabId];
  if (!entry) return;
  const left = await update('session', PARKED_KEY, (p) => delete p[tabId]);
  if (!windowClosing && !Object.values(left).some((p) => p.wsId === entry.wsId)) await dropParkedRecord(entry.wsId);
}

/** Moves the parked groups of `windowId` back to the end, after the workspace's own tabs. */
export async function tidyParkedGroups(windowId) {
  if (!chrome.tabGroups) return;
  const parked = await getParked();
  const tabs = await chrome.tabs.query({ windowId });
  const groupIds = [...new Set(tabs.filter((t) => parked[t.id] && t.groupId >= 0).map((t) => t.groupId))];
  for (const groupId of groupIds) await chrome.tabGroups.move(groupId, { index: -1 }).catch(() => {});
}

/** Tracks parked groups again after their tab ids changed (restart, extension update), in one window or all. */
export async function recognizeParkedGroups(windowId = null) {
  if (!chrome.tabGroups) return;
  const records = await read('local', PARKED_GROUPS_KEY);
  if (!Object.keys(records).length) return;
  const parked = await getParked();
  const tracked = new Set(Object.values(parked).map((p) => p.wsId));
  const pending = Object.fromEntries(Object.entries(records).filter(([wsId]) => !tracked.has(wsId)));
  if (!Object.keys(pending).length) return;
  const groups = [];
  const pages = new Map();
  const groupOf = new Map();
  for (const group of await chrome.tabGroups.query(windowId == null ? {} : { windowId })) {
    const tabs = (await chrome.tabs.query({ groupId: group.id })).map((t) => ({ id: t.id, url: pageOf(t) }));
    for (const t of tabs) {
      pages.set(t.id, t.url);
      groupOf.set(t.id, group.id);
    }
    groups.push({ title: group.title ?? '', tabs });
  }
  const now = Date.now();
  for (const { wsId, tabIds } of recognizeParked(groups, pending)) {
    const { entries, kept } = reparkEntries(wsId, tabIds.map((id) => ({ id, url: pages.get(id) })), pending[wsId], now);
    await update('session', PARKED_KEY, (p) => Object.assign(p, entries));
    if (kept.length) await markTabs(kept);
    // Groups parked before they went untitled lose their name too.
    if (pending[wsId].title) {
      await chrome.tabGroups.update(groupOf.get(tabIds[0]), { title: '' }).catch(() => {});
      await update('local', PARKED_GROUPS_KEY, (records) => records[wsId] && (records[wsId].title = ''));
    }
  }
}
