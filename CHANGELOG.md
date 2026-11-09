# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Home tab: a pinned tab with the extension icon at the left of every window opens a page showing this window's workspace, with every other workspace one click away (can be turned off in settings).
- Pinned tabs stay open in every workspace instead of being swapped out (can be turned off in settings).
- After a workspace switch the window shows the Open Workspaces page (the home tab) instead of jumping to the workspace's last used tab, which still loads in the background. Can be turned off in settings.
- Optionally, tabs of the workspace you switch away from keep running for a while (off by default; 5, 15, 30 or 60 minutes in settings), in its collapsed tab group at the end of the window, so a quick look at another workspace doesn't cost a reload: come back in time and they return in place as they were. Each tab closes once unused for that long; one playing sound waits for it to stop, and the browser may still free their memory when it runs low.
- A tab playing sound (a video, also in picture-in-picture, music, a call) keeps playing through a workspace switch instead of closing: it waits in the workspace's group and closes 5 minutes after it goes quiet, unless the workspace opens again first.
- Keep tabs running: mark a tab (lightning button in the tab list, or right-click the page) and switching workspaces no longer closes it. It waits, still running, in a collapsed tab group named after its workspace at the end of the window, and comes back in place without a reload. Marked tabs are never suspended.
- Pin suggestions: opening an always-on site (Gmail, Google Calendar, Google Chat, Outlook, Proton Mail, Yahoo Mail, WhatsApp, Telegram, Slack, Microsoft Teams, Discord, Spotify, YouTube Music) in an unpinned tab asks in the toolbar popup, once per browser session, whether to pin it; a site can be muted, and the suggestions turned off in settings.
- Workspace images: upload a PNG, ICO, SVG, JPG or WebP as the workspace icon; custom workspace colors.

### Changed

- New visual design (see DESIGN.md): every workspace is a color swatch. The home tab and dashboard show the current workspace as a large swatch above a rack of all workspaces; popup and side panel use the same swatch laid horizontally. Bundled Archivo and Fragment Mono fonts, large text section tabs, new icon.

### Fixed

- A save that was already running when you switched workspaces could finish late and briefly store a half-switched tab list.
- Workspaces could swallow each other's tabs, more of them on every switch: clicking another workspace while a switch was still running left the tabs of the ones in between in the window, saved into the last one. Switches now run one at a time, and of several quick clicks only the last is carried out.
- A tab of the workspace being left that had already closed by itself (a login page, for one) kept the tabs after it from closing, so they ended up in the next workspace.
- A tab of another workspace waiting in the window (a video still playing, say) could be taken for the current workspace's after the extension reloaded or the browser restarted, if its page had moved on meanwhile (the next video): it was then saved into, and stuck to, the workspace on screen. Switching now also folds waiting groups back up.
- A tab marked to keep running could be lost: if its page changed while it waited for its workspace (a dashboard rotating screens, the next video) and the extension then reloaded or the browser restarted, it was closed. Waiting groups now follow their tabs' pages, and a tab whose mark can't be told for sure stays.
- A tab group of your own named like a workspace could be taken for that workspace's waiting group after a reload. Waiting groups now carry an invisible mark at the end of their name.
- Closing a workspace with other windows open closed its marked tabs, and the tabs other workspaces had waiting in that window. They now move to another window and keep running.
- If the browser refused to group the tabs of the workspace being left (one had just closed, or a tab was being dragged), every one of them closed, marked ones too. Now the others still wait, and a refusal is tried again.
- Marking a tab that was waiting only for a while (it was playing sound, say) didn't stop it from closing when that while ran out.
- A pinned tab marked to keep running closed on a switch when pinned tabs are part of each workspace. It now waits unpinned and comes back pinned.
- Moving a waiting tab into the workspace on screen left it inside the other workspace's group.
- A tab dragged out to a window of its own could take over a closed workspace that had that page, and the workspace was then saved with that one tab.
- A window brought back with Ctrl+Shift+T after its waiting group's workspace was opened elsewhere mixed that group's tabs into its own workspace.
- Restoring a workspace no longer leaves a stray copy of a waiting tab behind when the browser refuses to move it back.

## [0.1.0] - 2026-10-29

First public version.

### Added

- Unlimited workspaces with name, emoji and color; archive, duplicate, reorder and delete.
- Switch workspaces in the current window or in a new window; automatic saving of tabs, pinned tabs and tab groups.
- Safe switching: windows with unsaved tabs are never replaced; closed workspaces keep their tabs.
- Automatic re-linking of windows to workspaces after a browser restart or when a window is reopened.
- Resources (saved links in sections) with drag and drop, notes and tasks per workspace.
- Quick switcher popup with search across workspaces, tabs and resources (Alt+A).
- Side panel (Alt+S), move tab to workspace (Alt+T), new workspace (Alt+N), next/previous/close workspace commands.
- Right-click menus to save pages and links or move tabs to a workspace.
- Lazy loading of restored tabs and optional auto-suspension with exclusions.
- JSON export/import (merge or replace).
- Light/dark theme; English and Brazilian Portuguese.
