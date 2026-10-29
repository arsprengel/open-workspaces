// Pure data helpers. No chrome.* calls in here, so everything is unit-testable in Node.

import { APP_ID, COLORS, DEFAULT_SETTINGS, SCHEMA_VERSION } from './constants.js';

export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

// ---------------------------------------------------------------------------
// URLs

const NEWTAB_RE = /^(chrome|edge|brave|vivaldi|opera|helium):\/\/(newtab|new-tab-page|startpageshared|startpage)\/?$/i;

/** True for empty/blank/new-tab URLs that shouldn't be stored as "real" tabs. */
export function isNewTabUrl(url) {
  if (!url) return true;
  return url === 'about:blank' || NEWTAB_RE.test(url) || url.startsWith('chrome-search://local-ntp');
}

/** Strips the hash so the same page with a different anchor still matches. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return str(url);
  }
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Parses the user's exclusion list. Lines that look like URLs are prefix matches,
 * anything else is treated as a domain (matching subdomains too).
 */
export function parseExclusions(text) {
  return str(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(l) ? { prefix: l } : { domain: l.replace(/^www\./, '').toLowerCase() }));
}

export function isExcluded(url, rules) {
  if (!rules.length) return false;
  const host = hostname(url).toLowerCase();
  return rules.some((r) => (r.prefix ? url.startsWith(r.prefix) : host === r.domain || host.endsWith(`.${r.domain}`)));
}

// ---------------------------------------------------------------------------
// Tabs

const MAX_FAVICON_LEN = 4096;

/** Converts a chrome.tabs.Tab into the minimal shape we persist. */
export function serializeTab(tab) {
  const fav = str(tab.favIconUrl);
  return {
    url: str(tab.pendingUrl) || str(tab.url),
    title: str(tab.title),
    favIconUrl: fav.length > MAX_FAVICON_LEN ? '' : fav,
    pinned: !!tab.pinned,
    active: !!tab.active,
    groupKey: typeof tab.groupId === 'number' && tab.groupId >= 0 ? String(tab.groupId) : null,
  };
}

export function serializeGroup(group) {
  return {
    key: String(group.id),
    title: str(group.title),
    color: str(group.color, 'grey'),
    collapsed: !!group.collapsed,
  };
}

/** Number of tabs worth showing (new tab pages don't count). */
export function realTabCount(ws) {
  return ws.tabs.filter((t) => !isNewTabUrl(t.url)).length;
}

// ---------------------------------------------------------------------------
// State

export function defaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

export function emptyState() {
  return { version: SCHEMA_VERSION, order: [], workspaces: {}, settings: defaultSettings() };
}

export function makeSection(name = '') {
  return { id: uid(), name, collapsed: false, items: [] };
}

export function makeWorkspace(partial = {}, index = 0) {
  const now = Date.now();
  return normalizeWorkspace({
    id: uid(),
    name: '',
    icon: '',
    color: COLORS[index % COLORS.length],
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: 0,
    archived: false,
    tabs: [],
    groups: [],
    sections: [makeSection()],
    notes: '',
    tasks: [],
    ...partial,
  });
}

function normalizeTabs(tabs) {
  return (Array.isArray(tabs) ? tabs : [])
    .filter((t) => isObj(t) && typeof t.url === 'string')
    .map((t) => ({
      url: t.url,
      title: str(t.title),
      favIconUrl: str(t.favIconUrl),
      pinned: !!t.pinned,
      active: !!t.active,
      groupKey: t.groupKey == null ? null : String(t.groupKey),
    }));
}

export function normalizeWorkspace(ws) {
  const sections = (Array.isArray(ws.sections) ? ws.sections : [])
    .filter(isObj)
    .map((s) => ({
      id: str(s.id) || uid(),
      name: str(s.name),
      collapsed: !!s.collapsed,
      items: (Array.isArray(s.items) ? s.items : [])
        .filter((i) => isObj(i) && typeof i.url === 'string')
        .map((i) => ({ id: str(i.id) || uid(), url: i.url, title: str(i.title), addedAt: Number(i.addedAt) || Date.now() })),
    }));
  return {
    id: str(ws.id) || uid(),
    name: str(ws.name),
    icon: str(ws.icon),
    color: str(ws.color, COLORS[0]),
    createdAt: Number(ws.createdAt) || Date.now(),
    updatedAt: Number(ws.updatedAt) || Date.now(),
    lastOpenedAt: Number(ws.lastOpenedAt) || 0,
    archived: !!ws.archived,
    tabs: normalizeTabs(ws.tabs),
    groups: (Array.isArray(ws.groups) ? ws.groups : [])
      .filter(isObj)
      .map((g) => ({ key: String(g.key), title: str(g.title), color: str(g.color, 'grey'), collapsed: !!g.collapsed })),
    sections: sections.length ? sections : [makeSection()],
    notes: str(ws.notes),
    tasks: (Array.isArray(ws.tasks) ? ws.tasks : [])
      .filter((t) => isObj(t) && typeof t.text === 'string')
      .map((t) => ({ id: str(t.id) || uid(), text: t.text, done: !!t.done, createdAt: Number(t.createdAt) || Date.now() })),
  };
}

function mergeSettings(raw) {
  const base = defaultSettings();
  if (!isObj(raw)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in raw)) continue;
    if (isObj(base[key])) out[key] = { ...base[key], ...(isObj(raw[key]) ? raw[key] : {}) };
    else if (typeof raw[key] === typeof base[key]) out[key] = raw[key];
  }
  return out;
}

/** Repairs anything loaded from storage or imported from a file into a valid state. */
export function normalizeState(raw) {
  if (!isObj(raw)) return emptyState();
  const workspaces = {};
  for (const ws of Object.values(isObj(raw.workspaces) ? raw.workspaces : {})) {
    if (!isObj(ws)) continue;
    const n = normalizeWorkspace(ws);
    workspaces[n.id] = n;
  }
  const order = (Array.isArray(raw.order) ? raw.order : []).filter((id, i, a) => workspaces[id] && a.indexOf(id) === i);
  for (const id of Object.keys(workspaces)) if (!order.includes(id)) order.push(id);
  return { version: SCHEMA_VERSION, order, workspaces, settings: mergeSettings(raw.settings) };
}

export function orderedWorkspaces(state, { archived = false } = {}) {
  return state.order.map((id) => state.workspaces[id]).filter((ws) => ws && ws.archived === archived);
}

// ---------------------------------------------------------------------------
// Window <-> workspace matching (used after a browser restart, when window ids change)

export function overlapScore(urlsA, urlsB) {
  const a = new Set(urlsA.filter((u) => !isNewTabUrl(u)).map(normalizeUrl));
  const b = new Set(urlsB.filter((u) => !isNewTabUrl(u)).map(normalizeUrl));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const u of a) if (b.has(u)) inter++;
  return inter / Math.max(a.size, b.size);
}

/**
 * Greedily pairs windows with workspaces by tab overlap.
 * @param {{id:number, urls:string[]}[]} windows
 * @param {{id:string, urls:string[]}[]} workspaces
 * @returns {Map<number,string>} windowId -> workspaceId
 */
export function matchWindows(windows, workspaces, threshold = 0.5) {
  const pairs = [];
  for (const w of windows) {
    for (const ws of workspaces) {
      const score = overlapScore(w.urls, ws.urls);
      if (score >= threshold) pairs.push({ w: w.id, ws: ws.id, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const result = new Map();
  const usedWs = new Set();
  for (const p of pairs) {
    if (result.has(p.w) || usedWs.has(p.ws)) continue;
    result.set(p.w, p.ws);
    usedWs.add(p.ws);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Search

/**
 * Searches workspace names, saved/open tabs and resources.
 * @returns {{type:'workspace'|'tab'|'resource', wsId:string, title:string, url?:string, score:number}[]}
 */
export function search(state, query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const matches = (text) => {
    const t = text.toLowerCase();
    return terms.every((term) => t.includes(term));
  };
  const out = [];
  for (const ws of orderedWorkspaces(state).concat(orderedWorkspaces(state, { archived: true }))) {
    if (matches(ws.name)) out.push({ type: 'workspace', wsId: ws.id, title: ws.name, score: ws.name.toLowerCase().startsWith(q) ? 3 : 2 });
    for (const tab of ws.tabs) {
      if (isNewTabUrl(tab.url)) continue;
      if (matches(`${tab.title} ${tab.url}`)) out.push({ type: 'tab', wsId: ws.id, title: tab.title || tab.url, url: tab.url, score: 1 });
    }
    for (const section of ws.sections) {
      for (const item of section.items) {
        if (matches(`${item.title} ${item.url}`)) out.push({ type: 'resource', wsId: ws.id, title: item.title || item.url, url: item.url, score: 1 });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Import / export

export function buildExport(state) {
  return { app: APP_ID, exportedAt: new Date().toISOString(), version: SCHEMA_VERSION, state };
}

/**
 * Merges or replaces state with an export file.
 * In merge mode workspaces get fresh ids so nothing existing is overwritten.
 */
export function applyImport(current, data, mode = 'merge') {
  const rawState = isObj(data) && isObj(data.state) ? data.state : data;
  if (!isObj(rawState) || !isObj(rawState.workspaces)) throw new Error('invalid-file');
  const incoming = normalizeState(rawState);
  if (mode === 'replace') return incoming;
  const next = structuredClone(current);
  for (const id of incoming.order) {
    const ws = { ...incoming.workspaces[id], id: uid() };
    next.workspaces[ws.id] = ws;
    next.order.push(ws.id);
  }
  return next;
}
