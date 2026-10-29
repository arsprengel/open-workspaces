// Side panel: a rail with every workspace on the left and the current workspace on the right.

import { html, render, useState } from '../vendor/preact-htm.js';
import { orderedWorkspaces } from '../shared/model.js';
import { call, t, useStore, useTheme, useUnsavedWindows, wsLabel } from '../ui/api.js';
import { Badge, DND, Icon, IconButton, ToastHost, getDrag, hasDrag, run, setDrag } from '../ui/components.js';
import { NewWorkspaceModal, UnsavedWindowList, WorkspaceDetail, WorkspaceList } from '../ui/views.js';

function Rail({ store, onNew }) {
  const [drop, setDrop] = useState(null);
  const list = orderedWorkspaces(store.state);

  const onDrop = async (e, ws) => {
    e.preventDefault();
    setDrop(null);
    const tab = getDrag(e, DND.tab);
    const res = getDrag(e, DND.resource);
    const moved = getDrag(e, DND.workspace);
    if (tab) await run(call('moveTabs', { tabIds: [tab.tabId], targetId: ws.id }), t('movedTo', wsLabel(ws)));
    else if (res && res.wsId !== ws.id) await run(call('moveResource', { wsId: res.wsId, itemId: res.itemId, toWsId: ws.id }), t('movedTo', wsLabel(ws)));
    else if (moved && moved.id !== ws.id) {
      const order = store.state.order.filter((id) => id !== moved.id);
      order.splice(order.indexOf(ws.id), 0, moved.id);
      await run(call('reorderWorkspaces', { order }));
    }
  };

  return html`<nav class="rail" aria-label=${t('workspaces')}>
    ${list.map(
      (ws) => html`<button
        key=${ws.id}
        class=${`rail-item${ws.id === store.currentId ? ' current' : ''}${store.isOpen(ws.id) ? ' open' : ''}${drop === ws.id ? ' drop' : ''}`}
        title=${wsLabel(ws)}
        aria-label=${wsLabel(ws)}
        aria-current=${ws.id === store.currentId}
        draggable="true"
        onDragStart=${(e) => setDrag(e, DND.workspace, { id: ws.id })}
        onDragOver=${(e) => {
          if (hasDrag(e, DND.tab) || hasDrag(e, DND.resource) || hasDrag(e, DND.workspace)) {
            e.preventDefault();
            setDrop(ws.id);
          }
        }}
        onDragLeave=${() => setDrop(null)}
        onDrop=${(e) => onDrop(e, ws)}
        onClick=${(e) => run(call('openWorkspace', { id: ws.id, windowId: store.windowId, newWindow: e.shiftKey }))}
      ><${Badge} ws=${ws} /></button>`,
    )}
    <button class="rail-item add" title=${t('newWorkspace')} aria-label=${t('newWorkspace')} onClick=${onNew}><${Icon} name="plus" /></button>
    <span class="spacer"></span>
    <${IconButton} icon="grid" title=${t('openDashboard')} onClick=${() => chrome.runtime.openOptionsPage()} />
  </nav>`;
}

function UnsavedView({ store, onNew }) {
  const [filter, setFilter] = useState('');
  const unsaved = useUnsavedWindows(store.windowMap).filter((w) => w.id === store.windowId);
  return html`<div style="padding:12px 10px;overflow:auto;flex:1">
    <div class="card" style="padding:14px;margin-bottom:12px">
      <div style="font-weight:700;font-size:14px">${t('unsavedWindow')}</div>
      <p class="muted" style="margin:4px 0 0;font-size:12.5px">${t('unsavedWindowLong')}</p>
    </div>
    <${UnsavedWindowList} windows=${unsaved} store=${store} />
    <div class="section-label"><span class="grow">${t('workspaces')}</span></div>
    <div class="search" style="margin:0 2px 6px">
      <${Icon} name="search" />
      <input class="input" placeholder=${t('filterWorkspaces')} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
    </div>
    <${WorkspaceList} store=${store} filter=${filter} onActivate=${(ws) => run(call('openWorkspace', { id: ws.id, windowId: store.windowId }))} />
    ${!Object.keys(store.state.workspaces).length &&
    html`<div class="empty">
      <p style="margin:0 0 8px">${t('noWorkspacesYet')}</p>
      <button class="btn primary sm" onClick=${onNew}>${t('newWorkspace')}</button>
    </div>`}
  </div>`;
}

function App() {
  const store = useStore();
  useTheme(store?.state);
  const [creating, setCreating] = useState(false);
  if (!store) return null;
  const current = store.currentId ? store.state.workspaces[store.currentId] : null;
  return html`<div class="sp">
    <${Rail} store=${store} onNew=${() => setCreating(true)} />
    <main>
      ${current ? html`<${WorkspaceDetail} ws=${current} store=${store} compact />` : html`<${UnsavedView} store=${store} onNew=${() => setCreating(true)} />`}
    </main>
    ${creating && html`<${NewWorkspaceModal} store=${store} onClose=${() => setCreating(false)} />`}
    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
