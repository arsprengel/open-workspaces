// UI-side helpers: talking to the service worker, reading state reactively, opening URLs.

import { useEffect, useLayoutEffect, useState } from '../vendor/preact-htm.js';
import { MSG, STATE_KEY, WINDOW_MAP_KEY } from '../shared/constants.js';
import { normalizeState, normalizeUrl } from '../shared/model.js';

export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

/** Display name of an always-on site (see PIN_SITES), translated where the product name is. */
export const siteName = (site) => chrome.i18n.getMessage(`site_${site.id}`) || site.name;

/** Calls an action in the service worker (see background/actions.js). */
export async function call(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type: MSG, action, payload });
  if (!res?.ok) throw new Error(res?.error ?? 'request-failed');
  return res.result;
}

/**
 * Live view of everything the UI needs: persisted state, which window shows which workspace,
 * and the window this page lives in.
 */
export function useStore() {
  const [data, setData] = useState(null);
  // Not useEffect: that waits for a painted frame, and a background tab (the home tab) paints none.
  useLayoutEffect(() => {
    let alive = true;
    const load = async () => {
      const [local, session, win] = await Promise.all([
        chrome.storage.local.get(STATE_KEY),
        chrome.storage.session.get(WINDOW_MAP_KEY),
        chrome.windows.getCurrent(),
      ]);
      if (!alive) return;
      const windowMap = session[WINDOW_MAP_KEY] ?? {};
      setData({
        state: normalizeState(local[STATE_KEY]),
        windowMap,
        windowId: win.id,
        currentId: windowMap[win.id] ?? null,
        isOpen: (wsId) => Object.values(windowMap).includes(wsId),
        windowOf: (wsId) => {
          const entry = Object.entries(windowMap).find(([, id]) => id === wsId);
          return entry ? Number(entry[0]) : null;
        },
      });
    };
    load();
    const onChange = (changes, area) => {
      if ((area === 'local' && changes[STATE_KEY]) || (area === 'session' && changes[WINDOW_MAP_KEY])) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);
  return data;
}

/** Live list of tabs in a window (or [] when windowId is null). */
export function useWindowTabs(windowId) {
  const [tabs, setTabs] = useState([]);
  useEffect(() => {
    if (windowId == null) {
      setTabs([]);
      return undefined;
    }
    let alive = true;
    let timer = null;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const list = await chrome.tabs.query({ windowId }).catch(() => []);
        if (chrome.tabGroups && list.some((tab) => tab.groupId >= 0)) {
          const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
          const colors = new Map(groups.map((g) => [g.id, g.color]));
          for (const tab of list) tab._groupColor = colors.get(tab.groupId);
        }
        if (alive) setTabs(list);
      }, 60);
    };
    refresh();
    const events = ['onCreated', 'onUpdated', 'onRemoved', 'onMoved', 'onAttached', 'onDetached', 'onActivated', 'onReplaced'];
    for (const e of events) chrome.tabs[e].addListener(refresh);
    return () => {
      alive = false;
      clearTimeout(timer);
      for (const e of events) chrome.tabs[e].removeListener(refresh);
    };
  }, [windowId]);
  return tabs;
}

/** Normal windows that aren't bound to any workspace ("unsaved windows"). */
export function useUnsavedWindows(windowMap) {
  const [wins, setWins] = useState([]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      if (alive) setWins(all.filter((w) => !(w.id in windowMap)));
    };
    refresh();
    const tabEvents = ['onCreated', 'onRemoved', 'onUpdated', 'onAttached', 'onDetached'];
    chrome.windows.onCreated.addListener(refresh);
    chrome.windows.onRemoved.addListener(refresh);
    for (const e of tabEvents) chrome.tabs[e].addListener(refresh);
    return () => {
      alive = false;
      chrome.windows.onCreated.removeListener(refresh);
      chrome.windows.onRemoved.removeListener(refresh);
      for (const e of tabEvents) chrome.tabs[e].removeListener(refresh);
    };
  }, [JSON.stringify(windowMap)]);
  return wins;
}

export function faviconUrl(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl || 'about:blank');
  u.searchParams.set('size', String(size));
  return u.toString();
}

/** Focuses a tab with this URL in the window, or opens a new one. */
export async function openUrl(url, windowId, { background = false } = {}) {
  const tabs = await chrome.tabs.query({ windowId });
  const target = normalizeUrl(url);
  const hit = tabs.find((tab) => normalizeUrl(tab.pendingUrl || tab.url) === target);
  if (hit && !background) return chrome.tabs.update(hit.id, { active: true });
  return chrome.tabs.create({ windowId, url, active: !background });
}

/** Applies the theme setting to <html data-theme>. */
export function useTheme(state) {
  useEffect(() => {
    const theme = state?.settings.theme ?? 'system';
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [state?.settings.theme]);
}

export function wsLabel(ws) {
  return ws?.name || t('untitled');
}

export function relativeTime(ts) {
  if (!ts) return t('never');
  const diff = Date.now() - ts;
  const rtf = new Intl.RelativeTimeFormat(chrome.i18n.getUILanguage(), { numeric: 'auto' });
  const units = [
    ['year', 31536e6],
    ['month', 2592e6],
    ['week', 6048e5],
    ['day', 864e5],
    ['hour', 36e5],
    ['minute', 6e4],
  ];
  for (const [unit, ms] of units) if (diff >= ms) return rtf.format(-Math.floor(diff / ms), unit);
  return t('justNow');
}

export async function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
