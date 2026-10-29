// Full-page dashboard: manage every workspace, settings and backups.

import { html, render, useEffect, useState } from '../vendor/preact-htm.js';
import { orderedWorkspaces } from '../shared/model.js';
import { t, useStore, useTheme, useUnsavedWindows } from '../ui/api.js';
import { Icon, ToastHost } from '../ui/components.js';
import { NewWorkspaceModal, SettingsView, UnsavedWindowList, WorkspaceDetail, WorkspaceList } from '../ui/views.js';

import { REPO_URL } from '../shared/constants.js';

function useRoute() {
  const parse = () => {
    const [, view = '', id = ''] = location.hash.split('/');
    return { view, id };
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
  return html`<div style="max-width:720px;margin:0 auto;padding:48px 24px">
    <img src="../../icons/icon-128.png" width="64" height="64" alt="" />
    <h1 style="font-size:28px;margin:16px 0 6px">${t('welcomeTitle')}</h1>
    <p class="muted" style="font-size:15px;margin:0 0 28px">${t('welcomeSubtitle')}</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">
      ${steps.map(
        (s) => html`<div class="card" style="padding:16px">
          <div class="hstack" style="font-weight:700;margin-bottom:6px"><span style="color:var(--accent)"><${Icon} name=${s.icon} /></span>${s.title}</div>
          <div class="muted">${s.text}</div>
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

function Sidebar({ store, route, onNew }) {
  const [filter, setFilter] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const unsaved = useUnsavedWindows(store.windowMap);
  const archivedCount = orderedWorkspaces(store.state, { archived: true }).length;
  const select = (ws) => go(`#/ws/${ws.id}`);

  return html`<aside class="sidebar">
    <div class="hstack" style="padding:14px 12px 10px">
      <img src="../../icons/icon-32.png" width="22" height="22" alt="" />
      <strong style="font-size:15px">Open Workspaces</strong>
    </div>
    <div style="padding:0 10px 8px" class="vstack">
      <div class="search">
        <${Icon} name="search" />
        <input class="input" placeholder=${t('filterWorkspaces')} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      </div>
      <button class="btn primary" onClick=${onNew}><${Icon} name="plus" />${t('newWorkspace')}</button>
    </div>
    <div class="sidebar-scroll">
      ${unsaved.length > 0 &&
      html`<div class="section-label">${t('unsavedWindows')}</div>
        <div style="padding:0 6px"><${UnsavedWindowList} windows=${unsaved} store=${store} /></div>`}
      <div class="section-label">${t('workspaces')}</div>
      <div style="padding:0 6px">
        <${WorkspaceList} store=${store} filter=${filter} selectedId=${route.view === 'ws' ? route.id : null} onActivate=${select} />
        ${!Object.keys(store.state.workspaces).length && html`<div class="muted" style="padding:6px 8px;font-size:12.5px">${t('noWorkspacesYet')}</div>`}
      </div>
      ${archivedCount > 0 &&
      html`<button class="section-label" style="border:0;background:none;width:100%;cursor:pointer" onClick=${() => setShowArchive((v) => !v)}>
          <${Icon} name=${showArchive ? 'chevronDown' : 'chevronRight'} /><span class="grow" style="text-align:left">${t('archive')} · ${archivedCount}</span>
        </button>
        ${showArchive && html`<div style="padding:0 6px"><${WorkspaceList} store=${store} archived filter=${filter} selectedId=${route.view === 'ws' ? route.id : null} onActivate=${select} /></div>`}`}
    </div>
    <div class="sidebar-foot">
      <a class=${`row${route.view === 'settings' ? ' selected' : ''}`} href="#/settings" style="color:inherit;text-decoration:none"><${Icon} name="settings" />${t('settings')}</a>
      <a class="row" href=${REPO_URL} target="_blank" rel="noopener" style="color:inherit;text-decoration:none"><${Icon} name="heart" />${t('contribute')}</a>
    </div>
  </aside>`;
}

function App() {
  const store = useStore();
  useTheme(store?.state);
  const route = useRoute();
  const [creating, setCreating] = useState(false);

  // Default route: the workspace of this window, else the welcome page.
  useEffect(() => {
    if (!store || route.view) return;
    if (new URLSearchParams(location.search).has('welcome')) go('#/welcome');
    else if (store.currentId) go(`#/ws/${store.currentId}`);
    else {
      const first = orderedWorkspaces(store.state)[0];
      go(first ? `#/ws/${first.id}` : '#/welcome');
    }
  }, [store, route.view]);

  if (!store) return null;
  const ws = route.view === 'ws' ? store.state.workspaces[route.id] : null;
  document.title = ws ? `${ws.icon ? `${ws.icon} ` : ''}${ws.name || t('untitled')} · Open Workspaces` : 'Open Workspaces';

  let main;
  if (route.view === 'settings') {
    main = html`<div style="padding:24px;overflow:auto;flex:1">
      <h1 style="font-size:22px;margin:0 0 18px">${t('settings')}</h1>
      <${SettingsView} state=${store.state} />
    </div>`;
  } else if (ws) {
    main = html`<${WorkspaceDetail} key=${ws.id} ws=${ws} store=${store} />`;
  } else {
    main = html`<div style="overflow:auto;flex:1"><${Welcome} store=${store} onNew=${() => setCreating(true)} /></div>`;
  }

  return html`<div class="dash">
    <${Sidebar} store=${store} route=${route} onNew=${() => setCreating(true)} />
    <main>${main}</main>
    ${creating && html`<${NewWorkspaceModal} store=${store} open=${false} onClose=${() => setCreating(false)} onCreated=${(id) => go(`#/ws/${id}`)} />`}
    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
