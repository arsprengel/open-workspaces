# Contributing to Open Workspaces

Thanks for helping! This project aims to stay **simple, private and free forever**.

## Getting started

1. Fork and clone the repo.
2. Load `extension/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
3. Edit the code, then click the reload icon on the extension card (reopen the popup/side panel to see UI changes).

There is no build step and no `npm install`: the code runs as plain ES modules. Node.js 20+ is only needed for the scripts below.

```bash
npm test          # unit tests for the pure data helpers
npm run check     # manifest, referenced files and translation keys
npm run smoke     # headless end-to-end test (needs Chromium/Chrome for Testing/Helium/Brave)
```

Please run `npm test` and `npm run check` before opening a PR, and `npm run smoke` if you touched `src/background/`.

## Where things live

- `src/background/`: the service worker. `store.js` is the single writer of state, `tabs.js` syncs windows ↔ workspaces, `actions.js` holds every operation the UI can request.
- `src/shared/model.js`: pure functions (no `chrome.*`), covered by `tests/model.test.js`. Put logic here when you can.
- `src/ui/`: shared Preact components and the workspace views used by both the side panel and the dashboard.

### Ground rules

- **Never lose user data.** Anything that closes tabs must save first. Add a smoke-test step for new flows that touch tabs or windows.
- **No network requests, analytics or remote code.** Everything stays local.
- **No new permissions** without discussing it in an issue first.
- Keep dependencies at zero (the vendored Preact+htm is the exception).
- Match the existing style: 2-space indent, single quotes, small functions, comments that explain *why*.

## Translations

1. Copy `extension/_locales/en/messages.json` to `extension/_locales/<locale>/messages.json` (use [Chrome locale codes](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales), e.g. `es`, `fr`, `de`, `pt_PT`).
2. Translate every `message` (keep `$p1$` placeholders as they are).
3. Run `npm run check`; it reports missing or extra keys.

When you add UI text, add the key to **every** locale (English is fine as a placeholder in other languages if you don't speak them).

## Commits and PRs

- One topic per PR, with a short description of what changed and how you tested it.
- Screenshots or a GIF help a lot for UI changes.
- Update `CHANGELOG.md` under "Unreleased".

## Releasing (maintainers)

1. Bump `version` in `extension/manifest.json` and `package.json`, and update `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag. The release workflow runs the checks and attaches the zip to a GitHub release.
