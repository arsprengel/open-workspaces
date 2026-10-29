# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Home tab: a pinned tab with the extension icon at the left of every window opens a page showing this window's workspace, with every other workspace one click away (can be turned off in settings).
- Pinned tabs stay open in every workspace instead of being swapped out (can be turned off in settings).
- Workspace images: upload a PNG, ICO, SVG, JPG or WebP as the workspace icon; custom workspace colors.

### Changed

- New visual design (see DESIGN.md): every workspace is a color swatch. The home tab and dashboard show the current workspace as a large swatch above a rack of all workspaces; popup and side panel use the same swatch laid horizontally. Bundled Archivo and Fragment Mono fonts, large text section tabs, new icon.

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
