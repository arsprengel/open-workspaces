// Tab suspension using Chrome's native tab discarding: suspended tabs keep their URL,
// title and favicon in the tab strip but free their memory until clicked again.

import { getState } from './store.js';
import { getMarks } from './keep-alive.js';
import { isExcluded, parseExclusions } from '../shared/model.js';

export const SUSPEND_ALARM = 'ow-auto-suspend';

export async function syncSuspendAlarm() {
  const { settings } = await getState();
  if (settings.suspend.mode === 'auto') {
    const existing = await chrome.alarms.get(SUSPEND_ALARM);
    if (!existing) await chrome.alarms.create(SUSPEND_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(SUSPEND_ALARM);
  }
}

function suspendable(tab, prefs, rules, marks) {
  if (tab.active || tab.discarded || !tab.url || marks[tab.id]) return false;
  if (!/^https?:/i.test(tab.url)) return false;
  if (prefs.neverPinned && tab.pinned) return false;
  if (prefs.neverAudible && tab.audible) return false;
  return !isExcluded(tab.url, rules);
}

export async function runAutoSuspend() {
  const { settings } = await getState();
  const prefs = settings.suspend;
  if (prefs.mode !== 'auto') return;
  const rules = parseExclusions(prefs.exclusions);
  const marks = await getMarks();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  let victims;
  if (prefs.strategy === 'idle') {
    const cutoff = now - Math.max(1, prefs.idleMinutes) * 60_000;
    victims = tabs.filter((t) => suspendable(t, prefs, rules, marks) && (t.lastAccessed ?? now) < cutoff);
  } else {
    const loaded = tabs.filter((t) => !t.discarded).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    victims = loaded.slice(Math.max(1, prefs.maxTabs)).filter((t) => suspendable(t, prefs, rules, marks));
  }
  await Promise.all(victims.map((t) => chrome.tabs.discard(t.id).catch(() => {})));
}

export async function suspendTabs({ tabIds }) {
  await Promise.all(tabIds.map((id) => chrome.tabs.discard(id).catch(() => {})));
}

/** Suspends every tab in the window except the active one (and audible or kept-alive ones). */
export async function suspendOtherTabs({ windowId }) {
  const tabs = await chrome.tabs.query({ windowId });
  const marks = await getMarks();
  const ids = tabs.filter((t) => !t.active && !t.discarded && !t.audible && !marks[t.id] && /^https?:/i.test(t.url ?? '')).map((t) => t.id);
  await suspendTabs({ tabIds: ids });
  return { count: ids.length };
}
