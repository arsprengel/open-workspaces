// Side panel: a rail with every workspace on the left and the current workspace on the right.

import { html, render, useState } from '../vendor/preact-htm.js';
import { orderedWorkspaces } from '../shared/model.js';
import { call, t, useStore, useTheme, wsLabel } from '../ui/api.js';
import { Badge, DND, Icon, IconButton, ToastHost, getDrag, hasDrag, run, setDrag } from '../ui/components.js';
import { NewWorkspaceModal, UnsavedSwatch, WorkspaceDetail, WorkspaceList } from '../ui/views.js';

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
      ><${Badge} ws=${ws} size="md" /></button>`,
    )}
    <button class="rail-item add" title=${t('newWorkspace')} aria-label=${t('newWorkspace')} onClick=${onNew}><${Icon} name="plus" /></button>
    <span class="spacer"></span>
    <${IconButton} icon="grid" title=${t('openDashboard')} onClick=${() => chrome.runtime.openOptionsPage()} />
  </nav>`;
}

function UnsavedView({ store, onNew, onSave }) {
  const [filter, setFilter] = useState('');
  return html`<div class="detail">
    <div class="detail-head"><${UnsavedSwatch} wide onSave=${onSave} /></div>
    <div class="detail-body compact">
      <p class="muted" style="margin:2px 6px 12px;font-size:12.5px;text-wrap:pretty">${t('unsavedWindowLong')}</p>
      <div class="search" style="margin:0 2px 4px">
        <${Icon} name="search" />
        <input class="input" placeholder=${t('filterWorkspaces')} aria-label=${t('filterWorkspaces')} value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      </div>
      <div class="section-label"><span class="grow">${t('workspaces')}</span></div>
      <${WorkspaceList} store=${store} layout="grid" filter=${filter} onNew=${onNew} onActivate=${(ws) => run(call('openWorkspace', { id: ws.id, windowId: store.windowId }))} />
    </div>
  </div>`;
}

function App() {
  const store = useStore();
  useTheme(store?.state);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!store) return null;
  const current = store.currentId ? store.state.workspaces[store.currentId] : null;
  return html`<div class="sp">
    <${Rail} store=${store} onNew=${() => setCreating(true)} />
    <main>
      ${current
        ? html`<${WorkspaceDetail} key=${current.id} ws=${current} store=${store} compact />`
        : html`<${UnsavedView} store=${store} onNew=${() => setCreating(true)} onSave=${() => setSaving(true)} />`}
    </main>
    ${creating && html`<${NewWorkspaceModal} store=${store} onClose=${() => setCreating(false)} />`}
    ${saving && html`<${NewWorkspaceModal} store=${store} fromWindowId=${store.windowId} onClose=${() => setSaving(false)} />`}
    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
