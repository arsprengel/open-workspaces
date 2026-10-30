// Toolbar popup: keyboard-first quick switcher, search, "move tab to" and "new workspace".

import { html, render, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { POPUP_INTENT_KEY } from '../shared/constants.js';
import { hostname, isNewTabUrl, orderedWorkspaces, realTabCount, search, suggestedSite } from '../shared/model.js';
import { call, faviconUrl, openUrl, siteName, t, useStore, useTheme, wsLabel } from '../ui/api.js';
import { Badge, Favicon, FieldMark, Icon, IconButton, ToastHost, run, swatchStyle } from '../ui/components.js';
import { NewWorkspaceModal } from '../ui/views.js';

async function takeIntent() {
  const { [POPUP_INTENT_KEY]: intent } = await chrome.storage.session.get(POPUP_INTENT_KEY);
  if (intent) await chrome.storage.session.remove(POPUP_INTENT_KEY);
  if (intent?.kind !== 'pin') return intent ?? 'switch';
  // Opened by the service worker to offer pinning an always-on site; skip it if the tab changed since.
  const tab = await chrome.tabs.get(intent.tabId).catch(() => null);
  const site = tab && !tab.pinned ? suggestedSite(tab.url) : null;
  return site?.id === intent.siteId ? { kind: 'pin', tab, site } : 'switch';
}

/** "Keep Gmail pinned in every workspace?" with pin, not now, and never ask again for this site. */
function PinAsk({ tab, site }) {
  const name = siteName(site);
  const done = () => window.close();
  return html`<div class="pin-ask">
    <div class="sw wide neutral">
      <div class="sw-field"><img src=${faviconUrl(tab.url, 64)} alt="" /></div>
      <div class="sw-label">
        <div class="sw-name truncate">${name}</div>
        <div class="sw-code mono truncate">${hostname(tab.url)}</div>
      </div>
    </div>
    <div>
      <h1 class="pin-ask-q">${t('pinAskQuestion', name)}</h1>
      <p class="muted">${t('pinAskDesc')}</p>
    </div>
    <div class="pin-ask-actions">
      <button class="btn primary" autofocus onClick=${async () => {
        await run(call('pinTab', { tabId: tab.id }));
        done();
      }}><${Icon} name="pin" />${t('pinAskYes')}</button>
      <button class="btn" onClick=${done}>${t('pinAskLater')}</button>
    </div>
    <button class="btn sm ghost pin-ask-mute" onClick=${async () => {
      await run(call('updateSettings', { patch: { pinMuted: { [site.id]: true } } }));
      done();
    }}>${t('pinAskNever', name)}</button>
  </div>`;
}

function App() {
  const store = useStore();
  useTheme(store?.state);
  const [intent, setIntent] = useState(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    takeIntent().then((i) => {
      setIntent(i);
      if (i === 'new') setCreating(true);
    });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => setActiveTab(tab ?? null));
  }, []);

  const moving = intent === 'move';

  const items = useMemo(() => {
    if (!store) return [];
    if (query.trim()) {
      return search(store.state, query).map((r) => ({ ...r, ws: store.state.workspaces[r.wsId] }));
    }
    return orderedWorkspaces(store.state)
      .filter((ws) => !(moving && ws.id === store.currentId))
      .map((ws) => ({ type: 'workspace', wsId: ws.id, ws }));
  }, [store, query, moving]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.row.kb')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!store || intent === null) return null;
  if (intent.kind === 'pin') return html`<${PinAsk} tab=${intent.tab} site=${intent.site} />`;

  const activate = async (item, { newWindow = false } = {}) => {
    if (moving) {
      if (activeTab) await run(call('moveTabs', { tabIds: [activeTab.id], targetId: item.wsId }));
      return window.close();
    }
    if (item.type === 'resource') {
      await openUrl(item.url, store.windowId);
      return window.close();
    }
    await run(call('openWorkspace', { id: item.wsId, windowId: store.windowId, newWindow }));
    return window.close();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && items[cursor]) {
      e.preventDefault();
      activate(items[cursor], { newWindow: e.shiftKey });
    }
  };

  const current = store.currentId ? store.state.workspaces[store.currentId] : null;
  const canSaveTab = activeTab && !isNewTabUrl(activeTab.url);

  return html`<div class="popup">
    <header class="popup-head">
      <div class="search popup-search">
        <${Icon} name="search" />
        <input
          ref=${inputRef}
          class="input"
          autofocus
          placeholder=${moving ? t('moveTabSearch') : t('searchPlaceholder')}
          value=${query}
          onInput=${(e) => setQuery(e.target.value)}
          onKeyDown=${onKeyDown}
          aria-label=${t('search')}
        />
      </div>
      <${IconButton} icon="panel" title=${t('openSidePanel')} onClick=${async () => {
        await chrome.sidePanel.open({ windowId: store.windowId });
        window.close();
      }} />
      <${IconButton} icon="grid" title=${t('openDashboard')} onClick=${() => {
        chrome.runtime.openOptionsPage();
        window.close();
      }} />
    </header>

    ${moving &&
    html`<div class="moving">
      <span class="muted">${t('movingTab')}</span>
      ${activeTab && html`<${Favicon} url=${activeTab.url} /><span class="truncate" style="font-weight:600">${activeTab.title}</span>`}
    </div>`}

    ${!moving && !query &&
    html`<div class="popup-current">
      ${current
        ? html`<div class="sw wide" style=${swatchStyle(current)}>
            <div class="sw-field"><${FieldMark} ws=${current} /></div>
            <div class="sw-label">
              <div class="sw-head">
                <div class="sw-name truncate">${wsLabel(current)}</div>
                ${canSaveTab && html`<${IconButton} icon="bookmark" title=${t('saveTabAsResource')} onClick=${() => run(call('addResources', { wsId: current.id, items: [{ url: activeTab.url, title: activeTab.title }] }), t('savedToResources'))} />`}
                <${IconButton} icon="power" title=${t('closeWorkspace')} onClick=${async () => {
                  await run(call('closeWorkspace', { id: current.id }));
                  window.close();
                }} />
              </div>
              <div class="sw-code mono">${realTabCount(current) === 1 ? t('tabCountOne') : t('tabCount', realTabCount(current))} · ${t('currentWorkspace')}</div>
            </div>
          </div>`
        : html`<div class="sw wide neutral">
            <div class="sw-field"><${Icon} name="window" /></div>
            <div class="sw-label">
              <div class="sw-head">
                <div class="sw-name truncate">${t('unsavedWindow')}</div>
                <button class="btn sm primary" onClick=${() => setCreating('window')}><${Icon} name="save" />${t('save')}</button>
              </div>
              <div class="sw-code mono">${t('unsavedWindowHint')}</div>
            </div>
          </div>`}
    </div>`}

    <div class="list" ref=${listRef} role="listbox">
      ${!query && !moving && items.length > 0 && html`<div class="section-label"><span class="grow">${t('workspaces')}</span><span class="count">${items.length}</span></div>`}
      ${moving && items.length > 0 && html`<div class="section-label">${t('moveToWorkspace')}</div>`}
      ${items.map((item, i) => {
        const kb = i === cursor;
        if (item.type === 'workspace') {
          const ws = item.ws;
          const open = store.isOpen(ws.id);
          return html`<div
            key=${`w${ws.id}`}
            class=${`row${kb ? ' kb' : ''}${ws.id === store.currentId ? ' selected' : ''}`}
            role="option"
            aria-selected=${kb}
            onMouseMove=${() => cursor !== i && setCursor(i)}
            onClick=${(e) => activate(item, { newWindow: e.shiftKey })}
          >
            <${Badge} ws=${ws} size="md" />
            <div class="grow"><div class="title">${wsLabel(ws)}${ws.archived ? html` <span class="muted">· ${t('archivedLabel')}</span>` : ''}</div></div>
            ${open && html`<span class="dot" title=${ws.id === store.currentId ? t('currentWindow') : t('openInAnotherWindow')}></span>`}
            <span class="meta">${realTabCount(ws) || ''}</span>
          </div>`;
        }
        return html`<div
          key=${`${item.type}${i}`}
          class=${`row${kb ? ' kb' : ''}`}
          role="option"
          aria-selected=${kb}
          onMouseMove=${() => cursor !== i && setCursor(i)}
          onClick=${() => activate(item)}
        >
          <${Favicon} url=${item.url} />
          <div class="grow">
            <div class="title">${item.title}</div>
            <div class="sub">${item.type === 'resource' ? t('resourceIn', wsLabel(item.ws)) : t('tabIn', wsLabel(item.ws))} · ${hostname(item.url)}</div>
          </div>
        </div>`;
      })}
      ${!items.length &&
      html`<div class="empty" style="margin:8px 4px">
        ${query ? t('noResults') : t('noWorkspacesYet')}
        ${!query && html`<div style="margin-top:10px"><button class="btn primary sm" onClick=${() => setCreating(true)}><${Icon} name="plus" />${t('newWorkspace')}</button></div>`}
      </div>`}
    </div>

    <footer class="popup-foot">
      <button class="btn sm ghost" onClick=${() => setCreating(true)}><${Icon} name="plus" />${t('newWorkspace')}</button>
      <span class="spacer"></span>
      <span class="keys"><span class="kbd">↵</span>${t('open')}<span class="kbd">⇧↵</span>${t('newWindow')}</span>
    </footer>

    ${creating &&
    html`<${NewWorkspaceModal}
      store=${store}
      uploadInTab
      fromWindowId=${creating === 'window' ? store.windowId : null}
      onClose=${() => setCreating(false)}
      onCreated=${async (id) => {
        if (moving && activeTab) await run(call('moveTabs', { tabIds: [activeTab.id], targetId: id }));
        window.close();
      }}
    />`}
    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
