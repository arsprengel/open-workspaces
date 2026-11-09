// Parked tabs: switching away from a workspace gathers some of its tabs in a collapsed tab group at the end
// of the window (named and colored like the workspace) instead of closing them: the ones marked to keep
// running (for as long as it takes), one playing sound (until a while after it goes quiet) and, when
// settings ask for it, the others too (for a while, in case the switch was a quick look elsewhere).
// Opening the workspace takes them back out, in place and without a reload.
// Marks and parked tabs are tab ids, so they live in storage.session. Each parked group is also recorded in
// storage.local, kept up to date while it waits, to recognise it once ids change (browser restart, extension
// update); its title ends with an invisible mark, so a group of the user's with the same name isn't taken for it.

import { dueParked, nearestGroupColor, recognizeParked, reparkEntries } from '../shared/model.js';
import { KEEP_ALIVE_KEY, PARKED_GROUPS_KEY, PARKED_KEY, PARKED_MARK } from '../shared/constants.js';
import { getState, windowForWorkspace } from './store.js';

export const PARKED_ALARM = 'ow-parked';

let queue = Promise.resolve();

/**
 * Read-modify-write of one storage key, one at a time, so a burst of tab events doesn't lose updates.
 * `fn` may wait on reads, never on update() itself.
 */
function update(area, key, fn) {
  const run = queue.then(async () => {
    const value = (await chrome.storage[area].get(key))[key] ?? {};
    await fn(value);
    await chrome.storage[area].set({ [key]: value });
    return value;
  });
  queue = run.catch(() => {});
  return run;
}

const read = async (area, key) => (await chrome.storage[area].get(key))[key] ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tabId -> true for every tab marked to keep running. */
export const getMarks = () => read('session', KEEP_ALIVE_KEY);
/** tabId -> {wsId, order, url, leftAt?} for every parked tab (see PARKED_KEY). */
export const getParked = () => read('session', PARKED_KEY);

/**
 * Marks tabs to keep running, or unmarks them. The browser's memory saver leaves marked tabs alone. A parked
 * tab marked now waits for its workspace however long it takes; one unmarked waits, from now, like any tab
 * left behind.
 */
export async function markTabs(tabIds, keep = true) {
  await update('session', KEEP_ALIVE_KEY, (marks) => {
    for (const id of tabIds) {
      if (keep) marks[id] = true;
      else delete marks[id];
    }
  });
  for (const id of tabIds) chrome.tabs.update(id, { autoDiscardable: !keep }).catch(() => {});
  const parked = await getParked();
  const wsIds = new Set(tabIds.filter((id) => parked[id]).map((id) => parked[id].wsId));
  if (!wsIds.size) return;
  const leftAt = Date.now();
  await update('session', PARKED_KEY, (p) => {
    for (const id of tabIds) {
      const entry = p[id];
      if (!entry) continue;
      delete entry.leftAt;
      delete entry.sound;
      delete entry.quietSince;
      if (!keep) entry.leftAt = leftAt;
    }
  });
  for (const wsId of wsIds) await saveRecord(wsId);
}

const pageOf = (tab) => tab.pendingUrl || tab.url;
const groupTitle = (ws) => `${ws.icon ? `${ws.icon} ` : ''}${ws.name || chrome.i18n.getMessage('untitled') || 'Workspace'}`;

/**
 * Rewrites the record of `wsId`'s parked group (see PARKED_GROUPS_KEY) from the tabs waiting for it, or
 * drops it when none are left. `title`: the workspace's name as the group shows it, without the mark.
 */
function saveRecord(wsId, title = null) {
  return update('local', PARKED_GROUPS_KEY, async (groups) => {
    const mine = Object.entries(await read('session', PARKED_KEY))
      .filter(([, p]) => p.wsId === wsId)
      .sort(([, a], [, b]) => a.order - b.order);
    if (!mine.length) {
      delete groups[wsId];
      return;
    }
    const pages = new Map((await chrome.tabs.query({})).map((t) => [t.id, pageOf(t)]));
    const ws = (await getState()).workspaces[wsId];
    groups[wsId] = {
      title: title ?? groups[wsId]?.title ?? (ws ? groupTitle(ws) : ''),
      tabs: mine.map(([id, p]) => ({ id: Number(id), order: p.order, url: p.url, now: pages.get(Number(id)) ?? p.url, keep: !p.leftAt })),
    };
  });
}

/**
 * Groups the tabs of `ids` still in `windowId`. The browser refuses the whole list when one tab is gone,
 * and any edit while the user drags a tab: gone tabs are left out, a refusal is tried again.
 * @returns {Promise<{groupId:number, ids:number[]}|null>}
 */
async function groupTabs(ids, windowId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(250 * attempt);
    const live = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t) => t?.windowId === windowId).map((t) => t.id);
    if (!live.length) return null;
    try {
      return { groupId: await chrome.tabs.group({ tabIds: live, createProperties: { windowId } }), ids: live };
    } catch (err) {
      console.warn('[open-workspaces] could not group tabs', err);
    }
  }
  return null;
}

/**
 * Gathers tabs leaving `ws` into a collapsed group at the end of their window. Those in `marks` wait until
 * the workspace opens again, the others only for a while. `orders` holds each tab's place in the workspace.
 * @returns {Promise<number[]>} the ids parked; empty if the browser refused (the caller closes them then).
 */
export async function parkTabs(ws, tabs, { marks = {}, orders = null } = {}) {
  if (!ws || !tabs.length || !chrome.tabGroups) return [];
  const title = groupTitle(ws);
  // Pinned tabs can't be grouped: they wait unpinned and come back pinned (their saved tab says so).
  for (const t of tabs) if (t.pinned) await chrome.tabs.update(t.id, { pinned: false }).catch(() => {});
  const grouped = await groupTabs(tabs.map((t) => t.id), tabs[0].windowId);
  if (!grouped) return [];
  const { groupId, ids } = grouped;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabGroups.update(groupId, { title: title + PARKED_MARK, color: nearestGroupColor(ws.color), collapsed: true });
      await chrome.tabGroups.move(groupId, { index: -1 });
      break;
    } catch (err) {
      console.warn('[open-workspaces] could not tidy the parked group', err);
      await sleep(250 * (attempt + 1));
    }
  }
  // Only marked tabs are safe from the browser's memory saver (see markTabs): the others it may still free
  // when memory runs low, and they come back with a reload.
  const leftAt = Date.now();
  await update('session', PARKED_KEY, (parked) =>
    tabs.forEach((t, i) => {
      if (ids.includes(t.id)) parked[t.id] = { wsId: ws.id, order: orders?.[i] ?? i, url: pageOf(t), ...(!marks[t.id] && { leftAt, ...(t.audible && { sound: true }) }) };
    }),
  );
  await saveRecord(ws.id, title);
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

/** A waiting tab went quiet: its wait counts from now. True if it is one. */
export async function noteQuiet(tabId) {
  if (!(await getParked())[tabId]?.leftAt) return false;
  await update('session', PARKED_KEY, (parked) => parked[tabId] && (parked[tabId].quietSince = Date.now()));
  return true;
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

/**
 * Moves a parked tab out of its group to the end of `windowId`. False if the tab is gone, or if the browser
 * keeps refusing: then it closes, so the fresh copy the caller opens doesn't leave it behind as a stray.
 */
export async function unparkTab(tabId, windowId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.ungroup(tabId);
      await chrome.tabs.move(tabId, { windowId, index: -1 });
      return true;
    } catch (err) {
      if (!(await chrome.tabs.get(tabId).catch(() => null))) return false;
      console.warn('[open-workspaces] could not bring a parked tab back', err);
      await sleep(250 * (attempt + 1));
    }
  }
  await chrome.tabs.remove(tabId).catch(() => {});
  return false;
}

/** Closes parked tabs for which `pick(tabId, entry)` is true (e.g. those of a deleted workspace). */
export async function closeParked(pick) {
  const closing = [];
  const wsIds = new Set();
  await update('session', PARKED_KEY, (parked) => {
    for (const [id, p] of Object.entries(parked)) {
      if (!pick(Number(id), p)) continue;
      closing.push(Number(id));
      wsIds.add(p.wsId);
      delete parked[id];
    }
  });
  for (const wsId of wsIds) await saveRecord(wsId);
  // One by one: closing a list stops at the first tab already gone.
  await Promise.all(closing.map((id) => chrome.tabs.remove(id).catch(() => {})));
}

/** Forgets the record of `wsId`'s parked group (its workspace is gone). */
export function dropParkedRecord(wsId) {
  return update('local', PARKED_GROUPS_KEY, (groups) => delete groups[wsId]);
}

/** Keeps moved tabs from being treated as parked any longer, out of their group. */
export async function unregisterParked(tabIds) {
  const parked = await getParked();
  const mine = tabIds.filter((id) => parked[id]);
  if (!mine.length) return;
  await update('session', PARKED_KEY, (p) => mine.forEach((id) => delete p[id]));
  await Promise.all(mine.map((id) => chrome.tabs.ungroup(id).catch(() => {})));
  for (const wsId of new Set(mine.map((id) => parked[id].wsId))) await saveRecord(wsId);
}

/** A parked tab went to another page: its record follows, so the group is still recognised after a restart. */
export async function noteParkedPage(tabId) {
  const entry = (await getParked())[tabId];
  if (entry) await saveRecord(entry.wsId);
}

/** The browser swapped a tab for another (prerendering): its mark and parked entry follow the new id. */
export async function replaceTab(addedId, removedId) {
  const [marks, parked] = await Promise.all([getMarks(), getParked()]);
  if (marks[removedId]) {
    await update('session', KEEP_ALIVE_KEY, (m) => {
      delete m[removedId];
      m[addedId] = true;
    });
  }
  const entry = parked[removedId];
  if (!entry) return;
  await update('session', PARKED_KEY, (p) => {
    delete p[removedId];
    p[addedId] = entry;
  });
  await saveRecord(entry.wsId);
}

/**
 * A tab closed. Its mark and parked entry go, but when its window is closing the parked group's record
 * stays: the browser may be quitting and bring the window back, group included, on the next start.
 */
export async function forgetTab(tabId, windowClosing = false) {
  const [marks, parked] = await Promise.all([getMarks(), getParked()]);
  if (marks[tabId]) await update('session', KEEP_ALIVE_KEY, (m) => delete m[tabId]);
  const entry = parked[tabId];
  if (!entry) return;
  await update('session', PARKED_KEY, (p) => delete p[tabId]);
  if (!windowClosing) await saveRecord(entry.wsId);
}

/**
 * Moves the parked groups of `windowId` back to the end, after the workspace's own tabs, collapsed again
 * (going back to a tab in one opens it, and open it looks like part of the workspace now in the window).
 */
export async function tidyParkedGroups(windowId) {
  if (!chrome.tabGroups) return;
  const parked = await getParked();
  const tabs = await chrome.tabs.query({ windowId });
  const groupIds = [...new Set(tabs.filter((t) => parked[t.id] && t.groupId >= 0).map((t) => t.groupId))];
  for (const groupId of groupIds) {
    await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
    await chrome.tabGroups.move(groupId, { index: -1 }).catch(() => {});
  }
}

/** Moves the parked groups of `fromWindowId`, about to close, to the end of `toWindowId`. */
export async function moveParkedGroups(fromWindowId, toWindowId) {
  if (!chrome.tabGroups) return;
  const parked = await getParked();
  const tabs = await chrome.tabs.query({ windowId: fromWindowId });
  const groupIds = [...new Set(tabs.filter((t) => parked[t.id] && t.groupId >= 0).map((t) => t.groupId))];
  for (const groupId of groupIds) {
    await chrome.tabGroups.move(groupId, { windowId: toWindowId, index: -1 }).catch((err) => console.warn('[open-workspaces] could not move a parked group', err));
  }
  await tidyParkedGroups(toWindowId);
}

/** Tracks the tabs of `group` as waiting for `wsId` again, as `record` (if any) says, under its current name. */
async function adoptGroup(wsId, group, record, title) {
  const { entries, kept } = reparkEntries(wsId, group.tabs, record ?? {}, Date.now());
  await update('session', PARKED_KEY, (p) => Object.assign(p, entries));
  if (kept.length) await markTabs(kept);
  // The group may carry an outdated title: the workspace was renamed, or an earlier version parked it.
  if (group.title !== title + PARKED_MARK) await chrome.tabGroups.update(group.id, { title: title + PARKED_MARK }).catch(() => {});
  await saveRecord(wsId, title);
}

/** Tracks parked groups again after their tab ids changed (restart, extension update), in one window or all. */
export async function recognizeParkedGroups(windowId = null) {
  if (!chrome.tabGroups) return;
  const records = await read('local', PARKED_GROUPS_KEY);
  const parked = await getParked();
  const tracked = new Set(Object.values(parked).map((p) => p.wsId));
  const pending = Object.fromEntries(Object.entries(records).filter(([wsId]) => !tracked.has(wsId)));
  const groups = [];
  for (const group of await chrome.tabGroups.query(windowId == null ? {} : { windowId })) {
    const tabs = (await chrome.tabs.query({ groupId: group.id })).map((t) => ({ id: t.id, url: pageOf(t), audible: t.audible }));
    // Groups already waiting for their workspace are left as they are.
    if (tabs.length && !tabs.some((t) => parked[t.id])) groups.push({ id: group.id, title: group.title ?? '', tabs });
  }
  if (!groups.length) return;
  const { workspaces } = await getState();
  const found = recognizeParked(groups, pending);
  for (const { wsId, tabIds } of found) {
    const group = groups.find((g) => g.tabs[0].id === tabIds[0]);
    await adoptGroup(wsId, group, pending[wsId], workspaces[wsId] ? groupTitle(workspaces[wsId]) : pending[wsId].title);
  }
  // A group the extension parked whose record is gone: its window closed and came back (Ctrl+Shift+T) after
  // its workspace opened elsewhere. If that workspace is open or has its tabs waiting somewhere else, these
  // are stale copies of tabs it has; otherwise they wait for it again.
  const claimed = new Set(found.map(({ tabIds }) => tabIds[0]));
  for (const group of groups) {
    if (claimed.has(group.tabs[0].id) || !group.title.endsWith(PARKED_MARK)) continue;
    const title = group.title.slice(0, -PARKED_MARK.length);
    const owners = Object.values(workspaces).filter((ws) => groupTitle(ws) === title);
    if (owners.length !== 1) continue;
    const [ws] = owners;
    if (tracked.has(ws.id) || found.some((f) => f.wsId === ws.id) || (await windowForWorkspace(ws.id)) != null) {
      await Promise.all(group.tabs.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
    } else {
      await adoptGroup(ws.id, group, null, title);
    }
  }
}
