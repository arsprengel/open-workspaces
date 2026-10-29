// Single-writer persistence layer. Only the service worker writes state; every UI
// surface reads it from chrome.storage and re-renders on chrome.storage.onChanged.

import { STATE_KEY, WINDOW_MAP_KEY } from '../shared/constants.js';
import { normalizeState } from '../shared/model.js';

let cache = null;
let queue = Promise.resolve();

export async function getState() {
  if (!cache) {
    const raw = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
    cache = normalizeState(raw);
  }
  return cache;
}

/**
 * Runs `fn(state)` exclusively (one mutation at a time) and persists the result.
 * If `fn` throws, the in-memory cache is dropped so it's reloaded from storage.
 */
export function mutate(fn) {
  const run = queue.then(async () => {
    const state = await getState();
    try {
      const result = await fn(state);
      await chrome.storage.local.set({ [STATE_KEY]: state });
      return result;
    } catch (err) {
      cache = null;
      throw err;
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** Replaces the whole state (used by import). */
export function replaceState(next) {
  return mutate((state) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, normalizeState(next));
  });
}

// ---------------------------------------------------------------------------
// windowId -> workspaceId. Lives in storage.session: survives service worker restarts,
// but is wiped on browser restart (window ids change anyway; see reconcileWindows()).

let windowMap = null;

export async function getWindowMap() {
  if (!windowMap) windowMap = (await chrome.storage.session.get(WINDOW_MAP_KEY))[WINDOW_MAP_KEY] ?? {};
  return windowMap;
}

export async function workspaceForWindow(windowId) {
  return (await getWindowMap())[windowId] ?? null;
}

export async function windowForWorkspace(wsId) {
  const map = await getWindowMap();
  const entry = Object.entries(map).find(([, id]) => id === wsId);
  return entry ? Number(entry[0]) : null;
}

/** Binds a window to a workspace (or unbinds it with wsId = null). A workspace lives in at most one window. */
export async function setWindowWorkspace(windowId, wsId) {
  const map = await getWindowMap();
  for (const [win, id] of Object.entries(map)) {
    if (Number(win) === windowId || (wsId && id === wsId)) delete map[win];
  }
  if (wsId) map[windowId] = wsId;
  await chrome.storage.session.set({ [WINDOW_MAP_KEY]: { ...map } });
}

export async function clearWindowMap() {
  windowMap = {};
  await chrome.storage.session.set({ [WINDOW_MAP_KEY]: {} });
}

export async function unbindWorkspace(wsId) {
  const win = await windowForWorkspace(wsId);
  if (win != null) await setWindowWorkspace(win, null);
}
