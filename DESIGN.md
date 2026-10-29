# Open Workspaces - Design contract

## Scene

Someone who lives in the browser all day (work, side projects, a trip being planned) jumps between
workspaces dozens of times a day, in a second or two, right next to the browser's own tab strip.
By day the browser is light, at night it is dark, so the extension never picks a theme of its own:
it mirrors the browser (system theme, with a manual override) and must feel like part of it.

## Direction

**The swatch book.** Every workspace is a printer's color swatch: a solid field of its color on
top, a white label underneath carrying its name and a short code line. The current workspace is a
large swatch; the others are a rack of small swatches you pick from, like pulling a chip from a
color fan. Color is the identity and does the work; everything around the swatches is quiet,
precise neutral chrome.

Replaces the first pass ("precision neutral" with tinted header and a serif title), rejected by
the user as generic.

Type: **Archivo** (variable width and weight) carries the labels and the UI: names set heavy and
slightly expanded (800, `font-stretch` 112%) like a swatch label, UI text at normal width.
**Fragment Mono** sets the code lines and counts ("4 TABS · THIS WINDOW"), uppercase, like a
swatch's color code. Both bundled in the extension (no remote requests).

## Color strategy

Full palette with one brand violet (user decision: "eu gosto do roxo").

- **Workspace color** (user-chosen, presets or any custom color): a full solid field on every
  swatch, big or small, and on every badge. Text never sits on a field, except the initial letter,
  which picks black or white by luminance. Emoji and uploaded images sit on the field.
- **Brand violet** `#6e56cf` (text `#5b45b5` light / `#b9a6ff` dark): primary buttons, focus rings,
  the ring around the current swatch, selected rows, switches, links, the logo.
- Neutral chrome: white labels on a light grey rack (`#efeff1`) by day; near-black labels on a
  darker rack at night. No cream, no tints, no gradients, no glows.

## References

- **Printer's swatch books and color chips**: the field-plus-label anatomy, the code line in a
  small monospaced caps, color as the only decoration.
- **Raycast**: keyboard-first list in the popup. Tight rows, the selected row is a soft filled
  pill, shortcuts live in a footer bar, keycaps look like small physical keys.
- **Linear**: neutral chrome, hairline borders, dense 13px UI where weight does the work.

## Signature

**The current workspace is a big swatch.** On the pinned home tab (the extension icon at the left
of the tab strip) and in the dashboard, the left column opens with a large swatch of the
workspace in this window, with the rack of every other workspace below it. One click on a chip
switches the window. Popup and side panel use the same swatch, laid horizontally.

## Standing rules

- Swatch anatomy everywhere: field on top (or left when horizontal), label below (or right).
  Field radius follows the swatch's outer radius; label is the swatch's own surface.
- Radius: 8px controls and rows, 12px small swatches and cards, 16px big swatches and modals.
- Section switcher: large text tabs (Archivo 700), counts in Fragment Mono.
- Icons: one stroke set, 1.75 stroke, 16px; 14px inside small buttons.
- Motion: 120-180ms ease-out on hover/press/open; small swatches lift 2px on hover; nothing moves
  under `prefers-reduced-motion`.
- Focus: 2px violet ring + 2px offset, visible on every interactive element.
- Contrast: 4.5:1 body text, 3:1 UI graphics.
- Every surface ships in light and dark, English and Brazilian Portuguese.
- Hyphen only. Never em dash or en dash in any file.
