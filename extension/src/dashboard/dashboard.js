// Full-page dashboard: manage every workspace, settings and backups.
// The same page runs in the pinned home tab (home.html sets data-mode="home"): there the sidebar
// switches this window's workspace and the main area always shows the workspace in this window.

import { html, render, useEffect, useState } from '../vendor/preact-htm.js';
import { isHomeUrl, isNewTabUrl, isWindowFixture, orderedWorkspaces } from '../shared/model.js';
import { call, t, useStore, useTheme, useUnsavedWindows, useWindowTabs, wsLabel } from '../ui/api.js';
import { Favicon, Icon, ToastHost, run, workspaceFavicon } from '../ui/components.js';
import {
  EditWorkspaceModal, NewWorkspaceModal, PinnedStrip, SettingsView, UnsavedSwatch, UnsavedWindowList, WorkspaceDetail, WorkspaceList, WorkspaceSwatch,
} from '../ui/views.js';

import { REPO_URL } from '../shared/constants.js';

const HOME = document.documentElement.dataset.mode === 'home';
const dashboardUrl = (hash = '') => chrome.runtime.getURL(`src/dashboard/dashboard.html${hash}`);

function useRoute() {
  const parse = () => {
    const [, view = '', id = '', action = ''] = location.hash.split('/');
    return { view, id, action };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

const go = (hash) => {
  location.hash = hash;
};

function Welcome({ store, onNew }) {
  const [saving, setSaving] = useState(false);
  const steps = [
    { icon: 'save', title: t('welcomeStep1Title'), text: t('welcomeStep1Text') },
    { icon: 'search', title: t('welcomeStep2Title'), text: t('welcomeStep2Text') },
    { icon: 'bookmark', title: t('welcomeStep3Title'), text: t('welcomeStep3Text') },
    { icon: 'pause', title: t('welcomeStep4Title'), text: t('welcomeStep4Text') },
  ];
  return html`<div style="max-width:760px;margin:0 auto;padding:56px 28px">
    <img src="../../icons/icon-128.png" width="56" height="56" alt="" />
    <h1 class="display" style="margin:20px 0 10px">${t('welcomeTitle')}</h1>
    <p class="muted" style="font-size:15px;margin:0 0 32px;max-width:560px;text-wrap:pretty">${t('welcomeSubtitle')}</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
      ${steps.map(
        (s) => html`<div class="card" style="padding:16px 18px">
          <div class="hstack" style="font-weight:650;margin-bottom:6px"><span style="color:var(--accent-text)"><${Icon} name=${s.icon} /></span>${s.title}</div>
          <div class="muted" style="text-wrap:pretty">${s.text}</div>
        </div>`,
      )}
    </div>
    <div class="hstack" style="margin-top:28px;gap:10px;flex-wrap:wrap">
      ${!store.currentId && html`<button class="btn primary" onClick=${() => setSaving(true)}><${Icon} name="save" />${t('saveThisWindow')}</button>`}
      <button class="btn" onClick=${onNew}><${Icon} name="plus" />${t('newWorkspace')}</button>
      <a class="btn ghost" href=${REPO_URL} target="_blank" rel="noopener"><${Icon} name="code" />${t('sourceCode')}</a>
    </div>
    <p class="muted" style="margin-top:28px;font-size:12.5px">${t('welcomeFootnote')}</p>
    ${saving && html`<${NewWorkspaceModal} store=${store} fromWindowId=${store.windowId} onClose=${() => setSaving(false)} onCreated=${(id) => go(`#/ws/${id}`)} />`}
  </div>`;
}

/** The swatch book: the featured workspace as a big swatch, then the rack of every workspace. */
function Sidebar({ store, route, featured, onNew, onSave }) {
  const [filter, setFilter] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const unsaved = useUnsavedWindows(store.windowMap).filter((w) => !HOME || w.id !== store.windowId);
  const archivedCount = orderedWorkspaces(store.state, { archived: true }).length;
  // In the home tab a click switches this window; in the dashboard it selects the workspace to manage.
  const select = HOME ? (ws) => ws.id !== store.currentId && run(call('openWorkspace', { id: ws.id, windowId: store.windowId })) : (ws) => go(`#/ws/${ws.id}`);
  const selectedId = HOME ? store.currentId : route.view === 'ws' ? route.id : null;
  const count = orderedWorkspaces(store.state).length;

  return html`<aside class="sidebar">
    <div class="brand">
      <img src="../../icons/icon-32.png" width="22" height="22" alt="" />
      <span>Open Workspaces</span>
    </div>
    <div class="sidebar-scroll">
      ${featured
        ? html`<${WorkspaceSwatch} key=${featured.id} ws=${featured} store=${store} />`
        : HOME && html`<${UnsavedSwatch} onSave=${onSave} />`}
      <div class="section-label"><span class="grow">${t('workspaces')}</span>${count > 0 && html`<span class="count">${count}</span>`}</div>
      ${count > 6 &&
      html`<div class="search rack-search">
        <${Icon} name="search" />
        <input class="input" placeholder=${t('filterWorkspaces')} aria-label=${t('filterWorkspaces')} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      </div>`}
      <${WorkspaceList} store=${store} layout="grid" filter=${filter} selectedId=${selectedId} onActivate=${select} onNew=${onNew} />
      ${unsaved.length > 0 &&
      html`<div class="section-label"><span class="grow">${t('unsavedWindows')}</span><span class="count">${unsaved.length}</span></div>
        <${UnsavedWindowList} windows=${unsaved} store=${store} layout="grid" />`}
      ${archivedCount > 0 &&
      html`<button class="section-label" aria-expanded=${showArchive} onClick=${() => setShowArchive((v) => !v)}>
          <${Icon} name=${showArchive ? 'chevronDown' : 'chevronRight'} /><span class="grow">${t('archive')}</span><span class="count">${archivedCount}</span>
        </button>
        ${showArchive && html`<${WorkspaceList} store=${store} layout="grid" archived filter=${filter} selectedId=${selectedId} onActivate=${select} />`}`}
    </div>
    <div class="sidebar-foot">
      ${HOME
        ? html`<a class="row" href=${dashboardUrl('#/settings')} target="_blank"><${Icon} name="settings" />${t('settings')}</a>`
        : html`<a class=${`row${route.view === 'settings' ? ' selected' : ''}`} href="#/settings"><${Icon} name="settings" />${t('settings')}</a>`}
      <a class="row" href=${REPO_URL} target="_blank" rel="noopener"><${Icon} name="heart" />${t('contribute')}</a>
    </div>
  </aside>`;
}

/** Home tab, window without a workspace: offer to save it, show what stays pinned. */
function HomeUnsaved({ store }) {
  const keepPinned = store.state.settings.keepPinned;
  const live = useWindowTabs(store.windowId).filter((tab) => !isHomeUrl(tab.pendingUrl || tab.url));
  const pinned = keepPinned ? live.filter((tab) => tab.pinned) : [];
  const tabs = live.filter((tab) => !isWindowFixture(tab, keepPinned) && !isNewTabUrl(tab.pendingUrl || tab.url));
  const focus = (tab) => chrome.tabs.update(tab.id, { active: true });
  return html`<div class="detail">
    <div class="detail-body">
      <div class="vstack" style="gap:16px">
        <p class="muted" style="max-width:560px;margin:0;text-wrap:pretty">${t('unsavedWindowLong')}</p>
        <${PinnedStrip} tabs=${pinned} windowId=${store.windowId} />
        ${tabs.length > 0 &&
        html`<div class="card">
          <div class="card-head"><span class="grow name">${t('windowTabs')} <span class="muted">${tabs.length}</span></span></div>
          <div class="card-body">
            ${tabs.map(
              (tab) => html`<div key=${tab.id} class="row" title=${tab.url} tabindex="0" onClick=${() => focus(tab)} onKeyDown=${(e) => e.key === 'Enter' && focus(tab)}>
                <${Favicon} url=${tab.pendingUrl || tab.url} />
                <div class="grow"><div class="title">${tab.title || tab.url}</div></div>
              </div>`,
            )}
          </div>
        </div>`}
      </div>
    </div>
  </div>`;
}

function App() {
  const store = useStore();
  useTheme(store?.state);
  const route = useRoute();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  // Default route: the workspace of this window, else the welcome page.
  useEffect(() => {
    if (HOME || !store || route.view) return;
    if (new URLSearchParams(location.search).has('welcome')) go('#/welcome');
    else if (store.currentId) go(`#/ws/${store.currentId}`);
    else {
      const first = orderedWorkspaces(store.state)[0];
      go(first ? `#/ws/${first.id}` : '#/welcome');
    }
  }, [store, route.view]);

  // The home tab's icon is the workspace of this window, so the tab strip says where you are.
  const homeWs = HOME && store?.currentId ? store.state.workspaces[store.currentId] : null;
  useEffect(() => {
    if (!HOME || !store) return undefined;
    let alive = true;
    const link = document.querySelector('link[rel=icon]');
    if (!homeWs) link.href = '../../icons/icon-32.png';
    else workspaceFavicon(homeWs).then((href) => alive && (link.href = href));
    return () => {
      alive = false;
    };
  }, [!!store, homeWs?.id, homeWs?.color, homeWs?.icon, homeWs?.image, homeWs?.name]);

  if (!store) return null;
  const ws = HOME ? (store.currentId ? store.state.workspaces[store.currentId] : null) : route.view === 'ws' ? store.state.workspaces[route.id] : null;
  // The home tab's tooltip names the workspace of this window.
  if (HOME) document.title = ws ? wsLabel(ws) : 'Open Workspaces';
  else document.title = ws ? `${ws.icon ? `${ws.icon} ` : ''}${wsLabel(ws)} · Open Workspaces` : 'Open Workspaces';

  let main;
  if (HOME) {
    main = ws ? html`<${WorkspaceDetail} key=${ws.id} ws=${ws} store=${store} header=${false} />` : html`<${HomeUnsaved} store=${store} />`;
  } else if (route.view === 'settings') {
    main = html`<div class="page"><div class="page-inner">
      <h1 class="page-title">${t('settings')}</h1>
      <${SettingsView} state=${store.state} />
    </div></div>`;
  } else if (ws) {
    main = html`<${WorkspaceDetail} key=${ws.id} ws=${ws} store=${store} header=${false} />`;
  } else {
    main = html`<div class="page"><${Welcome} store=${store} onNew=${() => setCreating(true)} /></div>`;
  }

  return html`<div class="dash">
    <${Sidebar} store=${store} route=${route} featured=${ws} onNew=${() => setCreating(true)} onSave=${() => setSaving(true)} />
    <main>${main}</main>
    ${creating && html`<${NewWorkspaceModal} store=${store} open=${HOME} onClose=${() => setCreating(false)} onCreated=${(id) => !HOME && go(`#/ws/${id}`)} />`}
    ${saving && html`<${NewWorkspaceModal} store=${store} fromWindowId=${store.windowId} onClose=${() => setSaving(false)} />`}
    ${!HOME && ws && route.action === 'edit' && html`<${EditWorkspaceModal} ws=${ws} onClose=${() => go(`#/ws/${ws.id}`)} />`}
    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
