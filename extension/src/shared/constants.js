// Shared constants used by the service worker and every UI surface.

export const APP_ID = 'open-workspaces';
export const SCHEMA_VERSION = 1;

/** chrome.storage.local key holding the whole persisted state. */
export const STATE_KEY = 'state';
/** chrome.storage.session key mapping windowId -> workspaceId (cleared on browser restart). */
export const WINDOW_MAP_KEY = 'windowMap';
/** chrome.storage.session key used to tell the popup which mode to open in (search, move tab, new...). */
export const POPUP_INTENT_KEY = 'popupIntent';
/** chrome.storage.session key: sites already offered for pinning this browser session (siteId -> true). */
export const PIN_ASKED_KEY = 'pinAsked';
/** The page shown in the pinned "home" tab at the left of every window. */
export const HOME_PAGE = 'src/home/home.html';
/** chrome.storage.session key: tabs marked to keep running while their workspace is closed (tabId -> true). */
export const KEEP_ALIVE_KEY = 'keepAlive';
/**
 * chrome.storage.session key: tabs of closed workspaces waiting (still running) in a collapsed tab group
 * at the end of some window (tabId -> {wsId, order, url, leftAt?}). Tabs marked to keep running wait
 * until their workspace opens again; the others (with `leftAt`) close after `waitMinutes` unused.
 */
export const PARKED_KEY = 'parked';
/**
 * chrome.storage.local key: title and URLs of each workspace's parked group (wsId -> {title, urls, kept}),
 * `kept` being the URLs of tabs marked to keep running, so the group is recognised again after a browser
 * restart or extension update, when tab ids change.
 */
export const PARKED_GROUPS_KEY = 'parkedGroups';

/**
 * Always-on sites (mail, chat, calendar, music) that belong next to the home tab rather than in one
 * workspace: opening one in an unpinned tab offers to pin it. `paths` limits a host to its app pages.
 */
export const PIN_SITES = [
  { id: 'gmail', name: 'Gmail', hosts: ['mail.google.com'] },
  { id: 'calendar', name: 'Google Calendar', hosts: ['calendar.google.com'] },
  { id: 'googlechat', name: 'Google Chat', hosts: ['chat.google.com'] },
  { id: 'outlook', name: 'Outlook', hosts: ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'] },
  { id: 'protonmail', name: 'Proton Mail', hosts: ['mail.proton.me'] },
  { id: 'yahoomail', name: 'Yahoo Mail', hosts: ['mail.yahoo.com'] },
  { id: 'whatsapp', name: 'WhatsApp', hosts: ['web.whatsapp.com'] },
  { id: 'telegram', name: 'Telegram', hosts: ['web.telegram.org'] },
  { id: 'slack', name: 'Slack', hosts: ['app.slack.com'] },
  { id: 'teams', name: 'Microsoft Teams', hosts: ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'] },
  { id: 'discord', name: 'Discord', hosts: ['discord.com'], paths: ['/channels', '/app'] },
  { id: 'spotify', name: 'Spotify', hosts: ['open.spotify.com'] },
  { id: 'youtubemusic', name: 'YouTube Music', hosts: ['music.youtube.com'] },
];

export const COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#64748b', // slate
];

export const EMOJIS = [
  '💼', '🏠', '🚀', '💡', '📚', '🎯', '🛠️', '💻', '📈', '💰', '🎨', '🎮',
  '🎵', '🎬', '✈️', '🛒', '🍳', '🏋️', '❤️', '⭐', '🔥', '🌱', '🧪', '📝',
  '📅', '📦', '🔒', '🌎', '🤝', '🧠', '⚙️', '🐛', '📣', '🎓', '🏢', '☕',
];

export const DEFAULT_SETTINGS = Object.freeze({
  /** 'current' replaces the tabs of the current window, 'newWindow' always opens a new window. */
  openMode: 'current',
  /** Restored tabs (other than the active one) are discarded so they don't load until clicked. */
  lazyLoadTabs: true,
  /** What clicking the toolbar icon does: 'popup' or 'sidepanel'. */
  actionClick: 'popup',
  /** 'system' | 'light' | 'dark' */
  theme: 'system',
  confirmDelete: true,
  /** Keep a pinned tab with the extension icon at the left of every window (opens the home page). */
  homeTab: true,
  /** After a workspace switch, show the home tab (this page) instead of the workspace's last used tab. */
  homeOnSwitch: true,
  /**
   * Minutes the tabs of a workspace you switched away from keep running (parked in a collapsed group) in
   * case you come back; each closes once unused that long. 0 (default) closes them on the switch.
   */
  waitMinutes: 0,
  /** Tabs pinned in the browser belong to the window: they stay open when switching workspaces. */
  keepPinned: true,
  /** Offer to pin always-on sites (PIN_SITES) when one opens in an unpinned tab. */
  pinSuggestions: true,
  /** Sites the user asked never to be offered again (siteId -> true). */
  pinMuted: {},
  /** Which sections a workspace shows. */
  views: { tabs: true, resources: true, notes: true, tasks: true },
  suspend: {
    /** 'manual' | 'auto' */
    mode: 'manual',
    /** 'maxTabs' keeps the N most recent tabs loaded, 'idle' suspends tabs unused for N minutes. */
    strategy: 'maxTabs',
    maxTabs: 25,
    idleMinutes: 30,
    neverPinned: true,
    neverAudible: true,
    /** Newline separated domains (example.com) or URL prefixes (https://example.com/page). */
    exclusions: '',
  },
});

/** Message types understood by the service worker (see background/actions.js). */
export const MSG = 'ow:call';

/** Update this when the repository moves. */
export const REPO_URL = 'https://github.com/arsprengel/open-workspaces';
