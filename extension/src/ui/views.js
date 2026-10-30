// Workspace-level views shared by the side panel and the dashboard.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { hostname, isHomeUrl, isNewTabUrl, isWindowFixture, orderedWorkspaces, realTabCount } from '../shared/model.js';
import { PIN_SITES } from '../shared/constants.js';
import { call, downloadJson, openUrl, relativeTime, siteName, t, useWindowTabs, wsLabel } from './api.js';
import {
  Badge, DND, Favicon, FieldMark, GROUP_COLORS, Icon, IconButton, InlineInput, Menu, MenuItem, MenuSep, MenuTitle,
  Modal, Switch, WorkspaceForm, getDrag, hasDrag, run, setDrag, swatchStyle, toast,
} from './components.js';

// ---------------------------------------------------------------------------
// Workspace actions shared across surfaces

export function confirmDelete(state, ws) {
  return !state.settings.confirmDelete || window.confirm(t('confirmDeleteWorkspace', wsLabel(ws)));
}

export async function deleteWs(store, ws) {
  if (confirmDelete(store.state, ws)) await run(call('deleteWorkspace', { id: ws.id }), t('deleted'));
}

/** "More" menu entries for a workspace. */
export function WorkspaceMenuItems({ ws, store, onEdit }) {
  const open = store.isOpen(ws.id);
  return html`
    ${!ws.archived && html`<${MenuItem} icon="window" label=${t('openInNewWindow')} onClick=${() => run(call('openWorkspace', { id: ws.id, newWindow: true }))} />`}
    ${open && html`<${MenuItem} icon="power" label=${t('closeWorkspace')} onClick=${() => run(call('closeWorkspace', { id: ws.id }))} />`}
    <${MenuItem} icon="edit" label=${t('edit')} onClick=${onEdit} />
    <${MenuItem} icon="copy" label=${t('duplicate')} onClick=${() => run(call('duplicateWorkspace', { id: ws.id }), t('duplicated'))} />
    ${ws.archived
      ? html`<${MenuItem} icon="restore" label=${t('unarchive')} onClick=${() => run(call('setArchived', { id: ws.id, archived: false }))} />`
      : html`<${MenuItem} icon="archive" label=${t('archive')} onClick=${() => run(call('setArchived', { id: ws.id, archived: true }), t('archived'))} />`}
    <${MenuSep} />
    <${MenuItem} icon="trash" label=${t('delete')} danger onClick=${() => deleteWs(store, ws)} />
  `;
}

export function EditWorkspaceModal({ ws, onClose }) {
  return html`<${WorkspaceForm}
    title=${t('editWorkspace')}
    submitLabel=${t('save')}
    initial=${ws}
    onClose=${onClose}
    onSubmit=${async (patch) => {
      await run(call('updateWorkspace', { id: ws.id, patch }));
      onClose();
    }}
  />`;
}

/**
 * `uploadInTab`: for the toolbar popup, where the file chooser would close the popup. Choosing to upload an
 * image there saves the workspace as it is and continues in the dashboard's editor.
 */
export function NewWorkspaceModal({ store, fromWindowId = null, open = true, uploadInTab = false, onClose, onCreated }) {
  const continueInTab = async (draft) => {
    const res = await run(call('createWorkspace', { ...draft, fromWindowId, open: false, windowId: store.windowId }));
    if (!res) return;
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/dashboard.html#/ws/${res.id}/edit`) });
    onClose();
    onCreated?.(res.id);
  };
  return html`<${WorkspaceForm}
    title=${fromWindowId != null ? t('saveWindowAsWorkspace') : t('newWorkspace')}
    submitLabel=${fromWindowId != null ? t('save') : t('create')}
    onClose=${onClose}
    onPickImageElsewhere=${uploadInTab ? continueInTab : undefined}
    onSubmit=${async (data) => {
      const res = await run(call('createWorkspace', { ...data, fromWindowId, open: fromWindowId == null && open, windowId: store.windowId }));
      onClose();
      if (res) onCreated?.(res.id);
    }}
  />`;
}

// ---------------------------------------------------------------------------
// Workspace list (sidebar)

export function WorkspaceList({ store, archived = false, selectedId, onActivate, onNew, filter = '', layout = 'list' }) {
  const grid = layout === 'grid';
  const [drop, setDrop] = useState(null); // { id, pos: 'before'|'after'|'into' }
  const [dragId, setDragId] = useState(null);
  const [editing, setEditing] = useState(null);
  const q = filter.trim().toLowerCase();
  const list = orderedWorkspaces(store.state, { archived }).filter((ws) => !q || wsLabel(ws).toLowerCase().includes(q));

  const onDragOver = (e, ws) => {
    const isWs = hasDrag(e, DND.workspace);
    if (!isWs && !hasDrag(e, DND.tab) && !hasDrag(e, DND.resource)) return;
    e.preventDefault();
    if (isWs && !archived) {
      const r = e.currentTarget.getBoundingClientRect();
      const before = grid ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
      setDrop({ id: ws.id, pos: before ? 'before' : 'after' });
    } else if (!isWs) setDrop({ id: ws.id, pos: 'into' });
  };

  const onDrop = async (e, ws) => {
    e.preventDefault();
    const pos = drop?.pos;
    setDrop(null);
    const wsDrag = getDrag(e, DND.workspace);
    const tabDrag = getDrag(e, DND.tab);
    const resDrag = getDrag(e, DND.resource);
    if (wsDrag && wsDrag.id !== ws.id) {
      const order = store.state.order.filter((id) => id !== wsDrag.id);
      const index = order.indexOf(ws.id) + (pos === 'after' ? 1 : 0);
      order.splice(index, 0, wsDrag.id);
      await run(call('reorderWorkspaces', { order }));
    } else if (tabDrag) {
      await run(call('moveTabs', { tabIds: [tabDrag.tabId], targetId: ws.id }), t('movedTo', wsLabel(ws)));
    } else if (resDrag && resDrag.wsId !== ws.id) {
      await run(call('moveResource', { wsId: resDrag.wsId, itemId: resDrag.itemId, toWsId: ws.id, toSectionId: null }), t('movedTo', wsLabel(ws)));
    }
  };

  const newRow = onNew && !q && (grid
    ? html`<button type="button" class="ws-chip add" onClick=${onNew}><${Icon} name="plus" /><span>${t('newWorkspace')}</span></button>`
    : html`<button type="button" class="row new-row" style="width:100%;border:0;background:none;font:inherit" onClick=${onNew}>
        <span class="plus"><${Icon} name="plus" /></span><span class="grow" style="text-align:left">${t('newWorkspace')}</span>
      </button>`);
  if (!list.length) return q ? html`<div class="muted" style="padding:8px">${t('noResults')}</div>` : newRow ? html`<div class=${grid ? 'rack' : ''}>${newRow}</div>` : null;
  const dnd = (ws) => ({
    draggable: 'true',
    onDragStart: (e) => {
      setDragId(ws.id);
      setDrag(e, DND.workspace, { id: ws.id });
    },
    onDragEnd: () => {
      setDragId(null);
      setDrop(null);
    },
    onDragOver: (e) => onDragOver(e, ws),
    onDragLeave: () => setDrop((d) => (d?.id === ws.id ? null : d)),
    onDrop: (e) => onDrop(e, ws),
  });

  if (grid) {
    return html`<div class="rack" role="list">
      ${list.map((ws) => {
        const open = store.isOpen(ws.id);
        const count = realTabCount(ws);
        const cls = ['ws-chip', selectedId === ws.id && 'current', dragId === ws.id && 'dragging', drop?.id === ws.id && `drop-${drop.pos}`].filter(Boolean).join(' ');
        return html`<div
          key=${ws.id}
          class=${cls}
          style=${swatchStyle(ws)}
          role="listitem"
          tabindex="0"
          title=${wsLabel(ws)}
          aria-current=${selectedId === ws.id ? 'true' : undefined}
          onClick=${() => onActivate(ws)}
          onKeyDown=${(e) => e.key === 'Enter' && onActivate(ws)}
          ...${dnd(ws)}
        >
          <div class="sw-field"><${FieldMark} ws=${ws} /></div>
          <div class="chip-label">
            <div class="chip-name">${wsLabel(ws)}</div>
            <div class="chip-code mono">
              ${open && html`<span class="dot" title=${store.currentId === ws.id ? t('currentWindow') : t('openInAnotherWindow')}></span>`}
              ${count === 1 ? t('tabCountOne') : t('tabCount', count)}
            </div>
          </div>
          <div class="chip-menu"><${Menu} sm>${() => html`<${WorkspaceMenuItems} ws=${ws} store=${store} onEdit=${() => setEditing(ws)} />`}<//></div>
        </div>`;
      })}
      ${newRow}
      ${editing && html`<${EditWorkspaceModal} ws=${editing} onClose=${() => setEditing(null)} />`}
    </div>`;
  }

  return html`<div role="list">
    ${list.map((ws) => {
      const open = store.isOpen(ws.id);
      const current = store.currentId === ws.id;
      const cls = ['row', selectedId === ws.id && 'selected', dragId === ws.id && 'dragging', drop?.id === ws.id && `drop-${drop.pos}`].filter(Boolean).join(' ');
      return html`<div
        key=${ws.id}
        class=${cls}
        role="listitem"
        tabindex="0"
        title=${wsLabel(ws)}
        onClick=${() => onActivate(ws)}
        onKeyDown=${(e) => e.key === 'Enter' && onActivate(ws)}
        ...${dnd(ws)}
      >
        <${Badge} ws=${ws} />
        <div class="grow">
          <div class="title" style=${current ? 'font-weight:600' : ''}>${wsLabel(ws)}</div>
        </div>
        ${open && html`<span class="dot hide-on-hover" title=${current ? t('currentWindow') : t('openInAnotherWindow')}></span>`}
        <span class="meta hide-on-hover">${realTabCount(ws) || ''}</span>
        <div class="actions">
          <${Menu} sm>${() => html`<${WorkspaceMenuItems} ws=${ws} store=${store} onEdit=${() => setEditing(ws)} />`}<//>
        </div>
      </div>`;
    })}
    ${newRow}
    ${editing && html`<${EditWorkspaceModal} ws=${editing} onClose=${() => setEditing(null)} />`}
  </div>`;
}

/** Windows that aren't saved as a workspace, with a "Save" button. */
export function UnsavedWindowList({ windows, store, layout = 'list' }) {
  const [saving, setSaving] = useState(null);
  if (!windows.length) return null;
  const describe = (win) => {
    const tabs = (win.tabs ?? []).filter((tab) => !isNewTabUrl(tab.pendingUrl || tab.url) && !isWindowFixture(tab, store.state.settings.keepPinned, store.parked));
    const first = tabs[0];
    const name = first ? (/^https?:/.test(first.url) ? hostname(first.url) : first.title || first.url) : '';
    return { tabs, name: name || t('emptyWindow') };
  };
  const modal = saving != null && html`<${NewWorkspaceModal} store=${store} fromWindowId=${saving} onClose=${() => setSaving(null)} />`;
  if (layout === 'grid') {
    return html`<div class="rack">
      ${windows.map((win) => {
        const { tabs, name } = describe(win);
        return html`<div key=${win.id} class="ws-chip neutral" role="button" tabindex="0" title=${t('focusWindow')} onClick=${() => chrome.windows.update(win.id, { focused: true })}>
          <div class="sw-field"><${Icon} name="window" /></div>
          <div class="chip-label">
            <div class="chip-name">${name}</div>
            <div class="chip-code mono">${win.id === store.windowId ? t('thisWindow') : tabs.length === 1 ? t('tabCountOne') : t('tabCount', tabs.length)}</div>
          </div>
          <button class="btn sm chip-save" onClick=${(e) => (e.stopPropagation(), setSaving(win.id))}>${t('save')}</button>
        </div>`;
      })}
      ${modal}
    </div>`;
  }
  return html`<div>
    ${windows.map((win) => {
      const { tabs, name } = describe(win);
      const label = tabs.length > 1 ? t('tabAndMore', name, tabs.length - 1) : name;
      return html`<div key=${win.id} class="row" onClick=${() => chrome.windows.update(win.id, { focused: true })} title=${t('focusWindow')}>
        <span class="badge neutral"><${Icon} name="window" /></span>
        <div class="grow">
          <div class="title">${label}</div>
          ${win.id === store.windowId && html`<div class="sub">${t('thisWindow')}</div>`}
        </div>
        <button class="btn sm" onClick=${(e) => (e.stopPropagation(), setSaving(win.id))}>${t('save')}</button>
      </div>`;
    })}
    ${modal}
  </div>`;
}

// ---------------------------------------------------------------------------
// Workspace detail

const VIEW_KEY = 'ow:view';

export function WorkspaceDetail({ ws, store, compact = false, header = true }) {
  const views = [
    { id: 'tabs', icon: 'tabs', label: t('tabs') },
    { id: 'resources', icon: 'bookmark', label: t('resources') },
    { id: 'notes', icon: 'note', label: t('notes') },
    { id: 'tasks', icon: 'checkSquare', label: t('tasks') },
  ].filter((v) => store.state.settings.views[v.id] !== false);
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) || 'tabs';
    } catch {
      return 'tabs';
    }
  });
  const active = views.find((v) => v.id === view) ? view : views[0]?.id;
  const choose = (id) => {
    setView(id);
    try {
      localStorage.setItem(VIEW_KEY, id);
    } catch {}
  };
  const counts = {
    tabs: realTabCount(ws),
    resources: ws.sections.reduce((n, s) => n + s.items.length, 0),
    tasks: ws.tasks.filter((x) => !x.done).length,
  };

  return html`<div class="detail" style=${swatchStyle(ws)}>
    ${header && html`<div class="detail-head"><${WorkspaceSwatch} ws=${ws} store=${store} wide /></div>`}
    ${views.length > 0 &&
    html`<nav class=${`sections${compact ? ' compact' : ''}`} role="tablist" aria-label=${wsLabel(ws)}>
      ${views.map(
        (v) => html`<button role="tab" aria-selected=${v.id === active} onClick=${() => choose(v.id)}>
          ${v.label}${counts[v.id] ? html`<span class="count">${counts[v.id]}</span>` : ''}
        </button>`,
      )}
    </nav>`}
    <div class=${`detail-body${compact ? ' compact' : ''}`}>
      <div>
        ${active === 'tabs' && html`<${TabsView} ws=${ws} store=${store} />`}
        ${active === 'resources' && html`<${ResourcesView} ws=${ws} store=${store} />`}
        ${active === 'notes' && html`<${NotesView} ws=${ws} />`}
        ${active === 'tasks' && html`<${TasksView} ws=${ws} />`}
      </div>
    </div>
  </div>`;
}

/** The workspace as a swatch: a field of its color (click to edit) over a label with its name. */
export function WorkspaceSwatch({ ws, store, wide = false }) {
  const [editing, setEditing] = useState(false);
  const open = store.isOpen(ws.id);
  const current = store.currentId === ws.id;
  const count = realTabCount(ws);
  const status = current ? t('openInThisWindow') : open ? t('openInAnotherWindow') : ws.archived ? t('archivedLabel') : t('lastOpened', relativeTime(ws.lastOpenedAt));
  const openButton = !current &&
    html`<button class="btn primary sm" onClick=${() => run(call('openWorkspace', { id: ws.id, windowId: store.windowId }))}>${open ? t('focus') : t('open')}</button>`;
  return html`<section class=${`sw${wide ? ' wide' : ''}`} style=${swatchStyle(ws)} aria-label=${wsLabel(ws)}>
    <button type="button" class="sw-field" title=${t('editWorkspace')} aria-label=${t('editWorkspace')} onClick=${() => setEditing(true)}>
      <${FieldMark} ws=${ws} />
      <span class="sw-edit" aria-hidden="true"><${Icon} name="edit" /></span>
    </button>
    <div class="sw-label">
      <div class="sw-head">
        <${InlineInput}
          value=${ws.name}
          placeholder=${t('untitled')}
          aria-label=${t('name')}
          onCommit=${(name) => run(call('updateWorkspace', { id: ws.id, patch: { name } }))}
        />
        ${wide && openButton}
        <${Menu}>${() => html`<${WorkspaceMenuItems} ws=${ws} store=${store} onEdit=${() => setEditing(true)} />`}<//>
      </div>
      <div class="sw-code mono">
        ${wide
          ? html`<span class="truncate">${count === 1 ? t('tabCountOne') : t('tabCount', count)} · ${status}</span>`
          : html`<span>${count === 1 ? t('tabCountOne') : t('tabCount', count)}</span><span>${status}</span>`}
      </div>
      ${!wide && openButton && html`<div class="sw-actions">${openButton}</div>`}
    </div>
    ${editing && html`<${EditWorkspaceModal} ws=${ws} onClose=${() => setEditing(false)} />`}
  </section>`;
}

/** Swatch for a window that isn't saved as a workspace yet: no color of its own. */
export function UnsavedSwatch({ wide = false, onSave }) {
  return html`<section class=${`sw neutral${wide ? ' wide' : ''}`}>
    <div class="sw-field"><${Icon} name="window" /></div>
    <div class="sw-label">
      <div class="sw-head"><div class="sw-name">${t('unsavedWindow')}</div></div>
      <div class="sw-code mono">${t('unsavedWindowHint')}</div>
      <div class="sw-actions"><button class="btn primary sm" onClick=${onSave}><${Icon} name="save" />${t('saveAsWorkspace')}</button></div>
    </div>
  </section>`;
}

/** Tabs pinned in the browser: they belong to the window and stay open in every workspace. */
export function PinnedStrip({ tabs, windowId }) {
  if (!tabs.length) return null;
  return html`<section class="pinned" aria-label=${t('pinnedTabs')}>
    <div class="pinned-head"><span>${t('pinnedTabs')}</span><span class="muted">${t('pinnedHint')}</span></div>
    <div class="pinned-list">
      ${tabs.map(
        (tab) => html`<button
          key=${tab.id}
          type="button"
          class=${`pin${tab.active ? ' on' : ''}`}
          title=${tab.url}
          onClick=${() => {
            chrome.tabs.update(tab.id, { active: true });
            chrome.windows.update(windowId, { focused: true });
          }}
        ><${Favicon} url=${tab.pendingUrl || tab.url} /><span class="truncate">${tab.title || hostname(tab.url)}</span></button>`,
      )}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Tabs

function MoveToMenu({ store, exclude, onPick }) {
  const list = orderedWorkspaces(store.state).filter((w) => w.id !== exclude);
  return html`<${Menu} icon="arrowRight" title=${t('moveToWorkspace')} sm>
    ${() => html`
      <${MenuTitle}>${t('moveToWorkspace')}<//>
      ${list.map((w) => html`<button type="button" class="menu-item" onClick=${() => onPick(w)}><${Badge} ws=${w} /><span class="truncate">${wsLabel(w)}</span></button>`)}
      ${list.length > 0 && html`<${MenuSep} />`}
      <${MenuItem} icon="plus" label=${t('newWorkspace')} onClick=${() => onPick(null)} />
    `}
  <//>`;
}

function TabsView({ ws, store }) {
  const windowId = store.windowOf(ws.id);
  const live = useWindowTabs(windowId);
  const groupColor = (key, groups) => GROUP_COLORS[groups.find((g) => g.key === key)?.color] ?? null;

  const moveTab = async (tabId, target) => {
    const targetId = target ? target.id : (await call('createWorkspace', { name: '' })).id;
    await run(call('moveTabs', { tabIds: [tabId], targetId }), t('movedTo', target ? wsLabel(target) : t('newWorkspace')));
  };

  if (windowId != null) {
    const keepPinned = store.state.settings.keepPinned;
    // Kept-alive tabs of other workspaces wait here in a collapsed group; they aren't this workspace's.
    const all = live.filter((tab) => !isHomeUrl(tab.pendingUrl || tab.url) && !store.parked[tab.id]);
    const tabs = keepPinned ? all.filter((tab) => !tab.pinned) : all;
    return html`<${PinnedStrip} tabs=${keepPinned ? all.filter((tab) => tab.pinned) : []} windowId=${windowId} />
    <div class="card">
      <div class="card-head">
        <span class="grow name">${t('openTabs')} <span class="muted">${tabs.length}</span></span>
        <button class="btn sm ghost" title=${t('saveAllAsResources')} onClick=${() => run(call('saveTabsAsResources', { wsId: ws.id, tabIds: tabs.map((x) => x.id) }), t('savedToResources'))}><${Icon} name="bookmark" />${t('saveAll')}</button>
        <${IconButton} icon="pause" sm title=${t('suspendOthers')} onClick=${() => run(call('suspendOtherTabs', { windowId }), t('tabsSuspended'))} />
      </div>
      <div class="card-body">
        ${!tabs.length && html`<div class="empty" style="margin:6px">${t('noOpenTabs')}</div>`}
        ${tabs.map(
          (tab) => html`<div
            key=${tab.id}
            class=${`row${tab.active ? ' selected' : ''}${tab.discarded ? ' discarded' : ''}`}
            draggable="true"
            onDragStart=${(e) => setDrag(e, DND.tab, { tabId: tab.id, url: tab.url })}
            onClick=${() => {
              chrome.tabs.update(tab.id, { active: true });
              chrome.windows.update(windowId, { focused: true });
            }}
            title=${tab.url}
          >
            ${tab.groupId >= 0 && html`<span class="grp" style=${`background:${GROUP_COLORS[tab._groupColor] ?? 'var(--accent)'}`}></span>`}
            <${Favicon} url=${tab.pendingUrl || tab.url} />
            <div class="grow">
              <div class="title">${tab.title || tab.url}</div>
            </div>
            ${tab.pinned && html`<span class="meta hide-on-hover" title=${t('pinned')}><${Icon} name="pin" /></span>`}
            ${store.keepAlive[tab.id] && html`<span class="meta keep-alive hide-on-hover" title=${t('keepAliveOn')}><${Icon} name="bolt" /></span>`}
            ${tab.discarded && html`<span class="meta hide-on-hover">${t('suspended')}</span>`}
            <div class="actions">
              <${IconButton}
                icon="bolt"
                sm
                pressed=${!!store.keepAlive[tab.id]}
                title=${store.keepAlive[tab.id] ? t('keepAliveStop') : t('keepAlive')}
                onClick=${() => run(call('setKeepAlive', { tabId: tab.id, keep: !store.keepAlive[tab.id] }), store.keepAlive[tab.id] ? null : t('keepAliveDone'))}
              />
              <${IconButton} icon="bookmark" sm title=${t('saveAsResource')} onClick=${() => run(call('saveTabsAsResources', { wsId: ws.id, tabIds: [tab.id] }), t('savedToResources'))} />
              <${MoveToMenu} store=${store} exclude=${ws.id} onPick=${(target) => moveTab(tab.id, target)} />
              ${!tab.active && !tab.discarded && html`<${IconButton} icon="pause" sm title=${t('suspend')} onClick=${() => call('suspendTabs', { tabIds: [tab.id] })} />`}
              <${IconButton} icon="x" sm title=${t('closeTab')} onClick=${() => chrome.tabs.remove(tab.id)} />
            </div>
          </div>`,
        )}
      </div>
    </div>`;
  }

  const saved = ws.tabs.map((tab, index) => ({ ...tab, index })).filter((tab) => !isNewTabUrl(tab.url));
  return html`<div class="card">
    <div class="card-head">
      <span class="grow name">${t('savedTabs')} <span class="muted">${saved.length}</span></span>
    </div>
    <div class="card-body">
      ${!saved.length && html`<div class="empty" style="margin:6px">${t('noSavedTabs')}</div>`}
      ${saved.map(
        (tab) => html`<div
          key=${tab.index}
          class="row"
          title=${tab.url}
          onClick=${() => openUrl(tab.url, store.windowId)}
        >
          ${tab.groupKey && groupColor(tab.groupKey, ws.groups) && html`<span class="grp" style=${`background:${groupColor(tab.groupKey, ws.groups)}`}></span>`}
          <${Favicon} url=${tab.url} />
          <div class="grow"><div class="title">${tab.title || tab.url}</div></div>
          ${tab.pinned && html`<span class="meta hide-on-hover"><${Icon} name="pin" /></span>`}
          ${tab.keepAlive && html`<span class="meta keep-alive hide-on-hover" title=${t('keepAliveOn')}><${Icon} name="bolt" /></span>`}
          <div class="actions">
            <${IconButton} icon="bookmark" sm title=${t('saveAsResource')} onClick=${() => run(call('addResources', { wsId: ws.id, items: [{ url: tab.url, title: tab.title }] }), t('savedToResources'))} />
            <${IconButton} icon="x" sm title=${t('remove')} onClick=${() => call('removeSavedTab', { wsId: ws.id, index: tab.index })} />
          </div>
        </div>`,
      )}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Resources

function ResourcesView({ ws, store }) {
  const [editing, setEditing] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { section, index }
  const [dragItem, setDragItem] = useState(null);

  const addCurrentTab = async (sectionId) => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: store.windowId });
    if (!tab || isNewTabUrl(tab.url)) return toast(t('nothingToSave'));
    await run(call('addResources', { wsId: ws.id, sectionId, items: [{ url: tab.url, title: tab.title }] }), t('savedToResources'));
  };

  const accepts = (e) => hasDrag(e, DND.resource) || hasDrag(e, DND.tab) || hasDrag(e, 'text/uri-list');

  const handleDrop = async (e, sectionId, index) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const res = getDrag(e, DND.resource);
    const tab = getDrag(e, DND.tab);
    if (res) return run(call('moveResource', { wsId: res.wsId, itemId: res.itemId, toWsId: ws.id, toSectionId: sectionId, toIndex: index }));
    if (tab) return run(call('saveTabsAsResources', { wsId: ws.id, sectionId, tabIds: [tab.tabId] }), t('savedToResources'));
    const url = e.dataTransfer.getData('text/uri-list')?.split('\n').find((l) => l && !l.startsWith('#'));
    if (url) return run(call('addResources', { wsId: ws.id, sectionId, items: [{ url, title: url }] }));
    return undefined;
  };

  return html`<div class="vstack">
    ${ws.sections.map(
      (section) => html`<div
        key=${section.id}
        class=${`card${section.collapsed ? ' collapsed' : ''}${dropTarget?.section === section.id && dropTarget.index === -1 ? ' drop-into' : ''}`}
        onDragOver=${(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          if (dropTarget?.section !== section.id || dropTarget.index !== -1) setDropTarget({ section: section.id, index: -1 });
        }}
        onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setDropTarget(null)}
        onDrop=${(e) => handleDrop(e, section.id, -1)}
      >
        <div class="card-head">
          <${IconButton} icon=${section.collapsed ? 'chevronRight' : 'chevronDown'} sm title=${section.collapsed ? t('expand') : t('collapse')} onClick=${() => call('updateSection', { wsId: ws.id, sectionId: section.id, patch: { collapsed: !section.collapsed } })} />
          <div class="grow">
            <${InlineInput} value=${section.name} placeholder=${t('resources')} aria-label=${t('sectionName')} style="font-weight:600;height:26px" onCommit=${(name) => call('updateSection', { wsId: ws.id, sectionId: section.id, patch: { name } })} />
          </div>
          <span class="meta">${section.items.length || ''}</span>
          <${IconButton} icon="plus" sm title=${t('addCurrentTab')} onClick=${() => addCurrentTab(section.id)} />
          <${Menu} sm>
            ${() => html`
              <${MenuItem} icon="bookmark" label=${t('addCurrentTab')} onClick=${() => addCurrentTab(section.id)} />
              ${store.isOpen(ws.id) && html`<${MenuItem} icon="tabs" label=${t('addAllOpenTabs')} onClick=${async () => {
                const tabs = await chrome.tabs.query({ windowId: store.windowOf(ws.id) });
                await run(call('saveTabsAsResources', { wsId: ws.id, sectionId: section.id, tabIds: tabs.map((x) => x.id) }), t('savedToResources'));
              }} />`}
              <${MenuItem} icon="external" label=${t('openAll')} onClick=${() => section.items.forEach((i) => chrome.tabs.create({ url: i.url, active: false, windowId: store.windowId }))} />
              <${MenuSep} />
              <${MenuItem} icon="trash" label=${t('deleteSection')} danger onClick=${() => {
                if (!section.items.length || window.confirm(t('confirmDeleteSection'))) call('removeSection', { wsId: ws.id, sectionId: section.id, dropItems: true });
              }} />
            `}
          <//>
        </div>
        ${!section.collapsed &&
        html`<div class="card-body">
          ${section.items.map(
            (item, index) => html`<div
              key=${item.id}
              class=${`row${dragItem === item.id ? ' dragging' : ''}${dropTarget?.section === section.id && dropTarget.index === index ? ' drop-before' : ''}`}
              title=${item.url}
              draggable="true"
              onDragStart=${(e) => {
                setDragItem(item.id);
                setDrag(e, DND.resource, { wsId: ws.id, itemId: item.id, url: item.url });
              }}
              onDragEnd=${() => {
                setDragItem(null);
                setDropTarget(null);
              }}
              onDragOver=${(e) => {
                if (!accepts(e)) return;
                e.preventDefault();
                e.stopPropagation();
                if (dropTarget?.section !== section.id || dropTarget.index !== index) setDropTarget({ section: section.id, index });
              }}
              onDrop=${(e) => handleDrop(e, section.id, index)}
              onClick=${(e) => openUrl(item.url, store.windowId, { background: e.ctrlKey || e.metaKey })}
              onAuxClick=${(e) => e.button === 1 && openUrl(item.url, store.windowId, { background: true })}
            >
              <${Favicon} url=${item.url} />
              <div class="grow">
                <div class="title">${item.title || item.url}</div>
                <div class="sub">${hostname(item.url)}</div>
              </div>
              <div class="actions">
                <${IconButton} icon="edit" sm title=${t('edit')} onClick=${() => setEditing(item)} />
                <${IconButton} icon="trash" sm danger title=${t('remove')} onClick=${() => call('removeResource', { wsId: ws.id, itemId: item.id })} />
              </div>
            </div>`,
          )}
          <${AddLinkInput} onAdd=${(url) => run(call('addResources', { wsId: ws.id, sectionId: section.id, items: [{ url, title: url }] }))} />
        </div>`}
      </div>`,
    )}
    <div>
      <button class="btn sm ghost" onClick=${() => call('addSection', { wsId: ws.id, name: '' })}><${Icon} name="folderPlus" />${t('addSection')}</button>
    </div>
    ${editing && html`<${ResourceModal} item=${editing} wsId=${ws.id} onClose=${() => setEditing(null)} />`}
  </div>`;
}

function normalizeTypedUrl(value) {
  const v = value.trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return `https://${v}`;
}

function AddLinkInput({ onAdd }) {
  const [value, setValue] = useState('');
  return html`<form
    style="padding:4px"
    onSubmit=${(e) => {
      e.preventDefault();
      const url = normalizeTypedUrl(value);
      if (url) onAdd(url);
      setValue('');
    }}
  >
    <input class="input" style="height:30px;font-size:12.5px;background:transparent;border-style:dashed" placeholder=${t('pasteLink')} aria-label=${t('pasteLink')} value=${value} onInput=${(e) => setValue(e.target.value)} />
  </form>`;
}

function ResourceModal({ item, wsId, onClose }) {
  const [title, setTitle] = useState(item.title);
  const [url, setUrl] = useState(item.url);
  return html`<${Modal} title=${t('editLink')} onClose=${onClose}>
    <form
      onSubmit=${async (e) => {
        e.preventDefault();
        await run(call('updateResource', { wsId, itemId: item.id, patch: { title, url: normalizeTypedUrl(url) } }));
        onClose();
      }}
    >
      <div class="field"><label>${t('title')}</label><input class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} /></div>
      <div class="field"><label>URL</label><input class="input" value=${url} onInput=${(e) => setUrl(e.target.value)} /></div>
      <div class="foot">
        <button type="button" class="btn" onClick=${onClose}>${t('cancel')}</button>
        <button type="submit" class="btn primary">${t('save')}</button>
      </div>
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------
// Notes & tasks

function NotesView({ ws }) {
  const [text, setText] = useState(ws.notes);
  const focused = useRef(false);
  const timer = useRef(null);
  useEffect(() => {
    if (!focused.current) setText(ws.notes);
  }, [ws.notes]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = (value) => call('setNotes', { wsId: ws.id, notes: value });
  return html`<textarea
    class="textarea notes"
    placeholder=${t('notesPlaceholder')}
    value=${text}
    onFocus=${() => (focused.current = true)}
    onBlur=${() => {
      focused.current = false;
      clearTimeout(timer.current);
      if (text !== ws.notes) save(text);
    }}
    onInput=${(e) => {
      const value = e.target.value;
      setText(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save(value), 500);
    }}
  ></textarea>`;
}

function TasksView({ ws }) {
  const [text, setText] = useState('');
  const pending = ws.tasks.filter((x) => !x.done);
  const done = ws.tasks.filter((x) => x.done);
  const Task = (task) => html`<div key=${task.id} class=${`task${task.done ? ' done' : ''}`}>
    <input type="checkbox" checked=${task.done} aria-label=${task.text} onChange=${(e) => call('updateTask', { wsId: ws.id, taskId: task.id, patch: { done: e.target.checked } })} />
    <div class="text">
      <${InlineInput} value=${task.text} style="height:26px" onCommit=${(value) => (value.trim() ? call('updateTask', { wsId: ws.id, taskId: task.id, patch: { text: value } }) : call('removeTask', { wsId: ws.id, taskId: task.id }))} />
    </div>
    <${IconButton} icon="trash" sm danger title=${t('remove')} onClick=${() => call('removeTask', { wsId: ws.id, taskId: task.id })} />
  </div>`;
  return html`<div class="vstack">
    <form
      onSubmit=${(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        call('addTask', { wsId: ws.id, text });
        setText('');
      }}
    >
      <input class="input" placeholder=${t('addTaskPlaceholder')} value=${text} onInput=${(e) => setText(e.target.value)} />
    </form>
    ${!ws.tasks.length && html`<div class="empty">${t('noTasks')}</div>`}
    <div>${pending.map(Task)}</div>
    ${done.length > 0 &&
    html`<div>
      <div class="section-label"><span class="grow">${t('completed')} · ${done.length}</span><button class="btn sm ghost" onClick=${() => call('clearDoneTasks', { wsId: ws.id })}>${t('clear')}</button></div>
      ${done.map(Task)}
    </div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Settings

function Section({ title, children }) {
  return html`<section class="card settings-card">
    <h2>${title}</h2>
    ${children}
  </section>`;
}

export function SettingsView({ state }) {
  const s = state.settings;
  const set = (patch) => run(call('updateSettings', { patch }));
  const setSuspend = (patch) => set({ suspend: patch });
  const mutedSites = PIN_SITES.filter((site) => s.pinMuted[site.id]);
  const [commands, setCommands] = useState([]);
  const fileRef = useRef(null);
  const [importMode, setImportMode] = useState('merge');
  useEffect(() => {
    chrome.commands.getAll().then(setCommands);
  }, []);

  const doImport = async (file) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (importMode === 'replace' && !window.confirm(t('confirmReplaceImport'))) return;
      const res = await call('importData', { data, mode: importMode });
      toast(t('importDone', res.count));
    } catch (err) {
      toast(t('importFailed', err.message), 'error');
    } finally {
      fileRef.current.value = '';
    }
  };

  return html`<div style="max-width:760px">
    <${Section} title=${t('settingsWorkspaces')}>
      <div class="setting">
        <div>
          <div class="label">${t('openingWorkspaces')}</div>
          <div class="radio-list">
            <label><input type="radio" name="openMode" checked=${s.openMode === 'current'} onChange=${() => set({ openMode: 'current' })} />${t('openModeCurrent')}</label>
            <label><input type="radio" name="openMode" checked=${s.openMode === 'newWindow'} onChange=${() => set({ openMode: 'newWindow' })} />${t('openModeNewWindow')}</label>
          </div>
          <div class="desc" style="margin-top:8px">${t('openModeHint')}</div>
        </div>
      </div>
      <div class="setting">
        <div><div class="label">${t('warmSetting')}</div><div class="desc">${t('warmDesc')}</div></div>
        <div class="control">
          <select class="select" style="width:auto" value=${String(s.warmMinutes)} aria-label=${t('warmSetting')} onChange=${(e) => set({ warmMinutes: Number(e.target.value) })}>
            <option value="0">${t('warmOff')}</option>
            ${[5, 15, 30].map((m) => html`<option value=${String(m)}>${t('warmMinutes', String(m))}</option>`)}
            <option value="60">${t('warmHour')}</option>
          </select>
        </div>
      </div>
      <div class="setting">
        <div><div class="label">${t('homeTabSetting')}</div><div class="desc">${t('homeTabDesc')}</div></div>
        <div class="control"><${Switch} checked=${s.homeTab} label=${t('homeTabSetting')} onChange=${(v) => set({ homeTab: v })} /></div>
      </div>
      ${s.homeTab &&
      html`<div class="setting">
        <div><div class="label">${t('homeOnSwitchSetting')}</div><div class="desc">${t('homeOnSwitchDesc')}</div></div>
        <div class="control"><${Switch} checked=${s.homeOnSwitch} label=${t('homeOnSwitchSetting')} onChange=${(v) => set({ homeOnSwitch: v })} /></div>
      </div>`}
      <div class="setting">
        <div><div class="label">${t('keepPinnedSetting')}</div><div class="desc">${t('keepPinnedDesc')}</div></div>
        <div class="control"><${Switch} checked=${s.keepPinned} label=${t('keepPinnedSetting')} onChange=${(v) => set({ keepPinned: v })} /></div>
      </div>
      ${s.keepPinned &&
      html`<div class="setting">
        <div>
          <div class="label">${t('pinSuggestionsSetting')}</div>
          <div class="desc">${t('pinSuggestionsDesc')}</div>
          ${mutedSites.length > 0 &&
          html`<div class="desc hstack" style="margin-top:8px;flex-wrap:wrap;gap:6px">
            ${t('pinMutedList', mutedSites.map(siteName).join(', '))}
            <button class="btn sm ghost" onClick=${() => set({ pinMuted: Object.fromEntries(mutedSites.map((site) => [site.id, false])) })}>${t('pinMutedReset')}</button>
          </div>`}
        </div>
        <div class="control"><${Switch} checked=${s.pinSuggestions} label=${t('pinSuggestionsSetting')} onChange=${(v) => set({ pinSuggestions: v })} /></div>
      </div>`}
      <div class="setting">
        <div><div class="label">${t('lazyLoad')}</div><div class="desc">${t('lazyLoadDesc')}</div></div>
        <div class="control"><${Switch} checked=${s.lazyLoadTabs} label=${t('lazyLoad')} onChange=${(v) => set({ lazyLoadTabs: v })} /></div>
      </div>
      <div class="setting">
        <div>
          <div class="label">${t('visibleSections')}</div>
          <div class="radio-list">
            ${['tabs', 'resources', 'notes', 'tasks'].map(
              (v) => html`<label class="check"><input type="checkbox" checked=${s.views[v] !== false} onChange=${(e) => set({ views: { [v]: e.target.checked } })} />${t(v)}</label>`,
            )}
          </div>
        </div>
      </div>
      <div class="setting">
        <div><div class="label">${t('confirmDeleteSetting')}</div></div>
        <div class="control"><${Switch} checked=${s.confirmDelete} label=${t('confirmDeleteSetting')} onChange=${(v) => set({ confirmDelete: v })} /></div>
      </div>
    <//>

    <${Section} title=${t('settingsSuspension')}>
      <div class="setting">
        <div>
          <div class="desc" style="margin:0 0 8px">${t('suspensionDesc')}</div>
          <div class="radio-list">
            <label><input type="radio" name="suspendMode" checked=${s.suspend.mode === 'manual'} onChange=${() => setSuspend({ mode: 'manual' })} />${t('suspendManual')}</label>
            <label><input type="radio" name="suspendMode" checked=${s.suspend.mode === 'auto'} onChange=${() => setSuspend({ mode: 'auto' })} />${t('suspendAuto')}</label>
          </div>
          ${s.suspend.mode === 'auto' &&
          html`<div class="radio-list" style="margin-left:24px">
            <label>
              <input type="radio" name="strategy" checked=${s.suspend.strategy === 'maxTabs'} onChange=${() => setSuspend({ strategy: 'maxTabs' })} />
              ${t('keepMaxBefore')}
              <input class="input" type="number" min="1" max="500" style="width:70px;height:28px" value=${s.suspend.maxTabs} onChange=${(e) => setSuspend({ maxTabs: Math.max(1, Number(e.target.value) || 25) })} />
              ${t('keepMaxAfter')}
            </label>
            <label>
              <input type="radio" name="strategy" checked=${s.suspend.strategy === 'idle'} onChange=${() => setSuspend({ strategy: 'idle' })} />
              ${t('suspendAfter')}
              <select class="select" style="width:auto;height:28px" value=${s.suspend.idleMinutes} onChange=${(e) => setSuspend({ idleMinutes: Number(e.target.value) })}>
                ${[5, 15, 30, 60, 120, 240, 720].map((m) => html`<option value=${m}>${m < 60 ? t('minutes', m) : t('hours', m / 60)}</option>`)}
              </select>
            </label>
          </div>`}
        </div>
      </div>
      <div class="setting">
        <div style="flex:1">
          <div class="label">${t('exclusions')}</div>
          <div class="radio-list">
            <label class="check"><input type="checkbox" checked=${s.suspend.neverPinned} onChange=${(e) => setSuspend({ neverPinned: e.target.checked })} />${t('neverPinned')}</label>
            <label class="check"><input type="checkbox" checked=${s.suspend.neverAudible} onChange=${(e) => setSuspend({ neverAudible: e.target.checked })} />${t('neverAudible')}</label>
          </div>
          <textarea class="textarea" style="min-height:80px;margin-top:10px" placeholder=${t('exclusionsPlaceholder')} value=${s.suspend.exclusions} onChange=${(e) => setSuspend({ exclusions: e.target.value })}></textarea>
        </div>
      </div>
    <//>

    <${Section} title=${t('settingsInterface')}>
      <div class="setting">
        <div><div class="label">${t('toolbarButton')}</div><div class="desc">${t('toolbarButtonDesc')}</div></div>
        <div class="control">
          <select class="select" style="width:auto" value=${s.actionClick} onChange=${(e) => set({ actionClick: e.target.value })}>
            <option value="popup">${t('quickSwitcher')}</option>
            <option value="sidepanel">${t('sidePanel')}</option>
          </select>
        </div>
      </div>
      <div class="setting">
        <div><div class="label">${t('theme')}</div></div>
        <div class="control">
          <select class="select" style="width:auto" value=${s.theme} onChange=${(e) => set({ theme: e.target.value })}>
            <option value="system">${t('themeSystem')}</option>
            <option value="light">${t('themeLight')}</option>
            <option value="dark">${t('themeDark')}</option>
          </select>
        </div>
      </div>
    <//>

    <${Section} title=${t('settingsShortcuts')}>
      ${commands.map(
        (c) => html`<div class="setting" style="padding:10px 0">
          <div class="label" style="font-weight:500">${c.name === '_execute_action' ? t('cmdSwitch') : c.description}</div>
          <div class="control">${c.shortcut ? c.shortcut.split('+').map((k) => html`<span class="kbd">${k}</span>`) : html`<span class="muted">${t('notSet')}</span>`}</div>
        </div>`,
      )}
      <div style="padding:12px 0">
        <button class="btn" onClick=${() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>${t('changeShortcuts')}</button>
      </div>
    <//>

    <${Section} title=${t('settingsBackup')}>
      <div class="setting">
        <div><div class="label">${t('exportData')}</div><div class="desc">${t('exportDesc')}</div></div>
        <div class="control">
          <button class="btn" onClick=${async () => {
            const data = await run(call('exportData'));
            if (data) downloadJson(`open-workspaces-${new Date().toISOString().slice(0, 10)}.json`, data);
          }}><${Icon} name="download" />${t('export')}</button>
        </div>
      </div>
      <div class="setting">
        <div>
          <div class="label">${t('importData')}</div>
          <div class="radio-list">
            <label><input type="radio" name="importMode" checked=${importMode === 'merge'} onChange=${() => setImportMode('merge')} />${t('importMerge')}</label>
            <label><input type="radio" name="importMode" checked=${importMode === 'replace'} onChange=${() => setImportMode('replace')} />${t('importReplace')}</label>
          </div>
        </div>
        <div class="control">
          <input ref=${fileRef} type="file" accept="application/json,.json" hidden onChange=${(e) => doImport(e.target.files[0])} />
          <button class="btn" onClick=${() => fileRef.current.click()}><${Icon} name="upload" />${t('import')}</button>
        </div>
      </div>
    <//>

    <p class="muted" style="text-align:center;font-size:12px">
      Open Workspaces v${chrome.runtime.getManifest().version} · ${t('aboutLine')}
    </p>
  </div>`;
}
