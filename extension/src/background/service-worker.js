// Entry point. All listeners are registered synchronously at the top level, as MV3
// requires, so events wake the service worker up correctly.

import * as actions from './actions.js';
import { cancelSnapshot, ensureHomeTab, isBusy, lastFocusedNormalWindow, scheduleSnapshot, syncHomeTabs } from './tabs.js';
import { getState, setWindowWorkspace, workspaceForWindow } from './store.js';
import { SUSPEND_ALARM, runAutoSuspend, suspendOtherTabs, suspendTabs, syncSuspendAlarm } from './suspender.js';
import { handleMenuClick, scheduleMenuRebuild } from './menus.js';
import { maybeSuggestPin, pinTab } from './pin-suggest.js';
import { MSG, POPUP_INTENT_KEY, STATE_KEY } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Messaging: UI -> service worker

const handlers = {
  ...actions,
  suspendTabs,
  suspendOtherTabs,
  pinTab,
  getCurrentWorkspace: async ({ windowId }) => ({ id: await workspaceForWindow(windowId) }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== MSG) return false;
  const fn = handlers[msg.action];
  if (typeof fn !== 'function') {
    sendResponse({ ok: false, error: `unknown-action:${msg.action}` });
    return false;
  }
  Promise.resolve()
    .then(() => fn(msg.payload ?? {}))
    .then(
      (result) => sendResponse({ ok: true, result: result ?? null }),
      (err) => {
        console.error(`[open-workspaces] ${msg.action} failed`, err);
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      },
    );
  return true; // async response
});

// ---------------------------------------------------------------------------
// Keep workspaces in sync with their windows

const TRACKED_TAB_CHANGES = ['url', 'title', 'pinned', 'groupId', 'favIconUrl', 'discarded'];

chrome.tabs.onCreated.addListener((tab) => scheduleSnapshot(tab.windowId));
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (TRACKED_TAB_CHANGES.some((key) => key in info)) scheduleSnapshot(tab.windowId);
});
chrome.tabs.onRemoved.addListener((_id, info) => {
  // When a window closes its tabs are removed one by one; ignore that so the workspace keeps them.
  if (!info.isWindowClosing) scheduleSnapshot(info.windowId);
});
chrome.tabs.onMoved.addListener((_id, info) => scheduleSnapshot(info.windowId));
chrome.tabs.onAttached.addListener((_id, info) => scheduleSnapshot(info.newWindowId));
chrome.tabs.onDetached.addListener((_id, info) => scheduleSnapshot(info.oldWindowId));
chrome.tabs.onActivated.addListener((info) => scheduleSnapshot(info.windowId));
chrome.tabs.onReplaced.addListener((tabId) => {
  chrome.tabs.get(tabId).then((tab) => scheduleSnapshot(tab.windowId), () => {});
});

if (chrome.tabGroups) {
  for (const event of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) {
    chrome.tabGroups[event].addListener((group) => scheduleSnapshot(group.windowId));
  }
}

// Opening Gmail, Slack and other always-on sites offers to pin them (see pin-suggest.js).
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete') maybeSuggestPin(tab);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(maybeSuggestPin, () => {});
});

chrome.windows.onRemoved.addListener((windowId) => {
  cancelSnapshot(windowId);
  setWindowWorkspace(windowId, null);
});

// A window reopened with Ctrl+Shift+T (or restored by the browser) gets re-linked to its workspace.
chrome.windows.onCreated.addListener((win) => {
  if (win.type !== 'normal') return;
  // Its tabs may still be loading, so try twice. Already-bound windows are skipped.
  for (const delay of [1000, 4000]) {
    setTimeout(() => actions.reconcileWindows({ onlyWindowId: win.id }).catch((err) => console.warn('[open-workspaces] reconcile', err)), delay);
  }
  // Every window gets the home tab (extension pages can't open in incognito). A restored window may bring
  // its own, so check again later to drop duplicates.
  if (win.incognito) return;
  for (const delay of [400, 4000]) {
    setTimeout(async () => {
      if (isBusy(win.id) || !(await getState()).settings.homeTab) return;
      ensureHomeTab(win.id);
    }, delay);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle

async function applyActionBehavior() {
  const { settings } = await getState();
  const useSidePanel = settings.actionClick === 'sidepanel';
  await chrome.action.setPopup({ popup: useSidePanel ? '' : 'src/popup/popup.html' });
  await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: useSidePanel }).catch(() => {});
}

async function boot() {
  await actions.reconcileWindows().catch((err) => console.warn('[open-workspaces] reconcile', err));
  if ((await getState()).settings.homeTab) await syncHomeTabs(true).catch((err) => console.warn('[open-workspaces] home tabs', err));
  await applyActionBehavior();
  await syncSuspendAlarm();
  scheduleMenuRebuild();
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await boot();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html?welcome=1') });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STATE_KEY]) return;
  const before = changes[STATE_KEY].oldValue;
  const after = changes[STATE_KEY].newValue;
  if (JSON.stringify(before?.settings) !== JSON.stringify(after?.settings)) {
    applyActionBehavior();
    syncSuspendAlarm();
  }
  if (before && after && before.settings?.homeTab !== after.settings?.homeTab) syncHomeTabs(after.settings.homeTab !== false);
  const menuKey = (s) => JSON.stringify((s?.order ?? []).map((id) => [id, s.workspaces[id]?.name, s.workspaces[id]?.icon, s.workspaces[id]?.archived]));
  if (menuKey(before) !== menuKey(after)) scheduleMenuRebuild();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SUSPEND_ALARM) runAutoSuspend();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((err) => console.error('[open-workspaces] menu', err));
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts

async function openPopupWithIntent(intent) {
  await chrome.storage.session.set({ [POPUP_INTENT_KEY]: intent });
  try {
    await chrome.action.openPopup();
  } catch {
    // openPopup isn't available everywhere (or no window is focused): fall back to the dashboard.
    await chrome.runtime.openOptionsPage();
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const windowId = tab?.windowId ?? (await lastFocusedNormalWindow());
  switch (command) {
    case 'move-tab':
      return openPopupWithIntent('move');
    case 'new-workspace':
      return openPopupWithIntent('new');
    case 'toggle-side-panel':
      if (windowId != null) return chrome.sidePanel.open({ windowId });
      return;
    case 'next-workspace':
      return actions.cycleWorkspace({ direction: 1, windowId });
    case 'previous-workspace':
      return actions.cycleWorkspace({ direction: -1, windowId });
    case 'close-workspace': {
      const id = windowId != null ? await workspaceForWindow(windowId) : null;
      if (id) return actions.closeWorkspace({ id });
      return;
    }
    case 'open-dashboard':
      return chrome.runtime.openOptionsPage();
  }
});
