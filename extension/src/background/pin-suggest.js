// Offers to pin always-on sites (Gmail, Slack, WhatsApp...) so they stay open across workspaces.
// The question shows in the toolbar popup, which needs no access to the site itself.

import { getState } from './store.js';
import { isBusy } from './tabs.js';
import { pinSuggestionFor, suggestedSite } from '../shared/model.js';
import { PIN_ASKED_KEY, POPUP_INTENT_KEY } from '../shared/constants.js';

const inFlight = new Set();

/** Asks whether to pin `tab` when it is the visible tab of a focused window and shows an always-on site. */
export async function maybeSuggestPin(tab) {
  if (!tab?.active || tab.status !== 'complete' || isBusy(tab.windowId)) return;
  // Every page load lands here: bail out early for other sites, and claim the site before any await so
  // the load and activation events of one tab can't both ask.
  const id = suggestedSite(tab.url)?.id;
  if (!id || inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const { settings } = await getState();
    const { [PIN_ASKED_KEY]: asked = {} } = await chrome.storage.session.get(PIN_ASKED_KEY);
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const site = pinSuggestionFor({ tab, windowTabs, settings, asked });
    if (!site) return;
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused || win.type !== 'normal') return;
    await chrome.storage.session.set({ [POPUP_INTENT_KEY]: { kind: 'pin', tabId: tab.id, siteId: site.id } });
    if (await openPopup(tab.windowId, settings)) {
      await chrome.storage.session.set({ [PIN_ASKED_KEY]: { ...asked, [site.id]: true } });
    } else {
      await chrome.storage.session.remove(POPUP_INTENT_KEY);
    }
  } catch (err) {
    console.warn('[open-workspaces] pin suggestion', err);
  } finally {
    inFlight.delete(id);
  }
}

async function openPopup(windowId, settings) {
  // With the side panel on the toolbar click there is no popup to open, so lend it one for this question.
  const lend = settings.actionClick === 'sidepanel';
  if (lend) await chrome.action.setPopup({ popup: 'src/popup/popup.html' });
  try {
    await chrome.action.openPopup({ windowId });
    return true;
  } catch {
    return false; // no focused window, or openPopup isn't available in this browser
  } finally {
    if (lend) await chrome.action.setPopup({ popup: '' });
  }
}

/** Pins a tab offered by the popup. Pinned tabs belong to the window, so it leaves its workspace. */
export async function pinTab({ tabId }) {
  await chrome.tabs.update(tabId, { pinned: true });
}
