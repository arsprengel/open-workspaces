// Right-click menus: save page/link to a workspace, move the tab to a workspace.

import { getState } from './store.js';
import { isHomeUrl, orderedWorkspaces } from '../shared/model.js';
import { addResources, createWorkspace, moveTabs, setKeepAlive } from './actions.js';
import { suspendOtherTabs } from './suspender.js';
import { getMarks } from './keep-alive.js';

const t = (key) => chrome.i18n.getMessage(key) || key;
const label = (ws) => `${ws.icon ? `${ws.icon} ` : ''}${ws.name || t('untitled')}`;

let rebuildTimer = null;
let building = Promise.resolve();

export function scheduleMenuRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    building = building.then(buildMenus).catch((err) => console.warn('[open-workspaces] menus', err));
  }, 300);
}

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const workspaces = orderedWorkspaces(await getState());
  const create = (props) =>
    new Promise((resolve) => {
      chrome.contextMenus.create(props, () => {
        void chrome.runtime.lastError; // duplicate ids during rapid rebuilds are harmless
        resolve();
      });
    });

  await create({ id: 'ow-keep-alive', type: 'checkbox', title: t('menuKeepAlive'), contexts: ['page'], checked: await activeTabMarked() });
  await create({ id: 'ow-dashboard', title: t('menuOpenDashboard'), contexts: ['action'] });
  await create({ id: 'ow-suspend-others', title: t('menuSuspendOthers'), contexts: ['action'] });

  const parents = [
    { id: 'ow-save-page', title: t('menuSavePage'), contexts: ['page'] },
    { id: 'ow-save-link', title: t('menuSaveLink'), contexts: ['link'] },
    { id: 'ow-move-tab', title: t('menuMoveTab'), contexts: ['page'] },
  ];
  for (const parent of parents) {
    await create(parent);
    for (const ws of workspaces) await create({ id: `${parent.id}:${ws.id}`, parentId: parent.id, title: label(ws), contexts: parent.contexts });
    if (parent.id === 'ow-move-tab') {
      if (workspaces.length) await create({ id: 'ow-move-tab-sep', parentId: parent.id, type: 'separator', contexts: parent.contexts });
      await create({ id: 'ow-move-tab:__new__', parentId: parent.id, title: t('menuNewWorkspace'), contexts: parent.contexts });
    }
  }
}

async function activeTabMarked() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return !!tab && !!(await getMarks())[tab.id];
}

/** The "keep running" checkbox is one item for all tabs: show the state of the tab in front. */
export async function syncKeepAliveMenu() {
  const checked = await activeTabMarked();
  chrome.contextMenus.update('ow-keep-alive', { checked }, () => void chrome.runtime.lastError);
}

export async function handleMenuClick(info, tab) {
  const [kind, wsId] = String(info.menuItemId).split(':');
  switch (kind) {
    case 'ow-keep-alive':
      if (tab && !isHomeUrl(tab.url)) await setKeepAlive({ tabId: tab.id, keep: info.checked });
      break;
    case 'ow-dashboard':
      await chrome.runtime.openOptionsPage();
      break;
    case 'ow-suspend-others':
      if (tab) await suspendOtherTabs({ windowId: tab.windowId });
      break;
    case 'ow-save-page':
      if (tab) await addResources({ wsId, items: [{ url: tab.url, title: tab.title }] });
      break;
    case 'ow-save-link':
      await addResources({ wsId, items: [{ url: info.linkUrl, title: info.selectionText || info.linkUrl }] });
      break;
    case 'ow-move-tab': {
      if (!tab || isHomeUrl(tab.url)) break;
      let target = wsId;
      if (target === '__new__') target = (await createWorkspace({ name: tab.title?.slice(0, 40) ?? '' })).id;
      await moveTabs({ tabIds: [tab.id], targetId: target });
      break;
    }
  }
}
