// Small reusable UI building blocks (Preact + htm, no build step).

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { COLORS, EMOJIS } from '../shared/constants.js';
import { faviconUrl, t } from './api.js';

// ---------------------------------------------------------------------------
// Icons (paths adapted from Lucide, ISC license)

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  tabs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  imageUp: '<path d="M21 13v5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h7"/><path d="m21 17-3.1-3.1a2 2 0 0 0-2.8 0L9 20"/><circle cx="9" cy="9" r="2"/><path d="M18 9V3M15 5.5 18 3l3 2.5"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
};

export function Icon({ name }) {
  return html`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: PATHS[name] ?? '' }}></svg>`;
}

export function IconButton({ icon, title, onClick, sm = false, danger = false, ...rest }) {
  return html`<button
    type="button"
    class=${`icon-btn${sm ? ' sm' : ''}${danger ? ' danger' : ''}`}
    title=${title}
    aria-label=${title}
    onClick=${(e) => {
      e.stopPropagation();
      onClick?.(e);
    }}
    ...${rest}
  ><${Icon} name=${icon} /></button>`;
}

// ---------------------------------------------------------------------------
// Workspace badge & favicons

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function readableOn(hex) {
  const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#fff';
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#17171c' : '#fff';
}

const initialOf = (ws) => (ws?.name || '?').trim().charAt(0).toUpperCase() || '?';

/** CSS variables that paint a swatch or badge in the workspace's color, with a readable foreground. */
export function swatchStyle(ws) {
  const color = ws?.color ?? '#64748b';
  const fg = readableOn(color);
  return `--c:${color};--field-fg:${fg};--badge-fg:${fg}`;
}

/** What sits on a swatch's color field: the uploaded image, else the emoji, else the initial. */
export function FieldMark({ ws }) {
  if (ws?.image) return html`<img src=${ws.image} alt="" />`;
  if (ws?.icon) return html`<span class="sw-glyph" aria-hidden="true">${ws.icon}</span>`;
  return html`<span class="sw-initial" aria-hidden="true">${initialOf(ws)}</span>`;
}

/** A workspace's identity at icon size: a tiny swatch. Sizes: sm, md, lg. */
export function Badge({ ws, lg = false, size = lg ? 'lg' : '' }) {
  const kind = ws?.image ? 'img' : ws?.icon ? 'emoji' : '';
  const content = ws?.image ? html`<img src=${ws.image} alt="" />` : ws?.icon || initialOf(ws);
  const cls = ['badge', size, kind].filter(Boolean).join(' ');
  return html`<span class=${cls} style=${swatchStyle(ws)} aria-hidden="true">${content}</span>`;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Reads an uploaded image (PNG, ICO, SVG, JPG, WebP...) and returns it as a small square PNG data URL. */
export async function imageToIcon(file, size = 96) {
  if (!file || file.size > MAX_UPLOAD_BYTES) throw new Error('image-too-big');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const scale = Math.min(size / w, size / h);
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Favicon({ url }) {
  return html`<img class="favicon" src=${faviconUrl(url)} alt="" loading="lazy" />`;
}

export const GROUP_COLORS = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

// ---------------------------------------------------------------------------
// Popover menu

export function Menu({ icon = 'more', title, align = 'right', up = false, sm = false, children, trigger }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const toggle = () => setOpen((o) => !o);
  return html`<div class="menu-wrap" ref=${ref} onClick=${(e) => e.stopPropagation()}>
    ${trigger ? trigger(toggle) : html`<${IconButton} icon=${icon} title=${title ?? t('more')} sm=${sm} onClick=${toggle} aria-expanded=${open} />`}
    ${open &&
    html`<div class=${`menu${align === 'left' ? ' left' : ''}${up ? ' up' : ''}`} role="menu" onClick=${() => setOpen(false)}>
      ${typeof children === 'function' ? children() : children}
    </div>`}
  </div>`;
}

export function MenuItem({ icon, label, onClick, danger = false }) {
  return html`<button type="button" role="menuitem" class=${`menu-item${danger ? ' danger' : ''}`} onClick=${onClick}>
    ${icon && html`<${Icon} name=${icon} />`}<span class="truncate">${label}</span>
  </button>`;
}

export const MenuSep = () => html`<div class="menu-sep"></div>`;
export const MenuTitle = ({ children }) => html`<div class="menu-title">${children}</div>`;

// ---------------------------------------------------------------------------
// Modal

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title}>
      <h2>${title}</h2>
      ${children}
    </div>
  </div>`;
}

/** Create / edit a workspace: name, color and an icon (uploaded image, emoji or initial). */
export function WorkspaceForm({ initial = {}, title, submitLabel, onSubmit, onClose }) {
  const [name, setName] = useState(initial.name ?? '');
  const [icon, setIcon] = useState(initial.icon ?? '');
  const [image, setImage] = useState(initial.image ?? '');
  const [color, setColor] = useState(initial.color ?? COLORS[Math.floor(Math.random() * COLORS.length)]);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  useEffect(() => inputRef.current?.focus(), []);
  const custom = !COLORS.includes(color);
  const pickIcon = (em) => {
    setIcon(em);
    setImage('');
  };
  const upload = async (file) => {
    if (!file) return;
    try {
      setImage(await imageToIcon(file));
      setIcon('');
    } catch {
      toast(t('imageFailed'), 'error');
    } finally {
      fileRef.current.value = '';
    }
  };
  const submit = (e) => {
    e.preventDefault();
    onSubmit({ name: name.trim(), icon, image, color });
  };
  return html`<${Modal} title=${title} onClose=${onClose}>
    <form onSubmit=${submit}>
      <div class="identity">
        <div class="sw" style=${swatchStyle({ color })} aria-hidden="true">
          <div class="sw-field"><${FieldMark} ws=${{ name: name || '?', icon, image, color }} /></div>
          <div class="sw-label"><span class="mono">${name.trim() || t('untitled')}</span></div>
        </div>
        <div class="field">
          <label for="ws-name">${t('name')}</label>
          <input id="ws-name" ref=${inputRef} class="input" value=${name} maxlength="80" placeholder=${t('workspaceNamePlaceholder')} onInput=${(e) => setName(e.target.value)} />
        </div>
      </div>
      <div class="field">
        <span class="field-label">${t('color')}</span>
        <div class="swatches">
          ${COLORS.map((c) => html`<button type="button" class="swatch" style=${`background:${c}`} aria-pressed=${c === color} aria-label=${c} onClick=${() => setColor(c)}></button>`)}
          <label class=${`swatch custom${custom ? ' on' : ''}`} style=${custom ? `background:${color}` : ''} title=${t('customColor')}>
            ${!custom && html`<${Icon} name="plus" />`}
            <input type="color" value=${color} aria-label=${t('customColor')} onInput=${(e) => setColor(e.target.value)} />
          </label>
        </div>
      </div>
      <div class="field">
        <div class="field-row">
          <span class="field-label">${t('icon')}</span>
          <button type="button" class="btn sm ghost" title=${t('uploadImageHint')} onClick=${() => fileRef.current.click()}><${Icon} name="imageUp" />${t('uploadImage')}</button>
        </div>
        <div class="emoji-grid">
          ${image && html`<button type="button" class="upload" aria-pressed="true" title=${t('uploadImage')} onClick=${() => fileRef.current.click()}><img src=${image} alt="" /></button>`}
          <button type="button" class="letter" aria-pressed=${!icon && !image} title=${t('noIcon')} onClick=${() => pickIcon('')}>Aa</button>
          ${EMOJIS.map((em) => html`<button type="button" aria-pressed=${em === icon && !image} onClick=${() => pickIcon(em)}>${em}</button>`)}
        </div>
        <input ref=${fileRef} type="file" accept="image/*,.ico,.svg" hidden onChange=${(e) => upload(e.target.files[0])} />
      </div>
      <div class="foot">
        <button type="button" class="btn" onClick=${onClose}>${t('cancel')}</button>
        <button type="submit" class="btn primary">${submitLabel}</button>
      </div>
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------
// Toasts

const toastListeners = new Set();
let toastSeq = 0;

export function toast(message, kind = 'info') {
  const item = { id: ++toastSeq, message, kind };
  for (const fn of toastListeners) fn(item);
}

/** Runs an async action and shows an error toast if it fails. */
export async function run(promise, successMessage) {
  try {
    const result = await promise;
    if (successMessage) toast(successMessage);
    return result;
  } catch (err) {
    console.error(err);
    toast(t('errorGeneric', err?.message ?? String(err)), 'error');
    return undefined;
  }
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onToast = (item) => {
      setItems((list) => [...list, item]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== item.id)), 2800);
    };
    toastListeners.add(onToast);
    return () => toastListeners.delete(onToast);
  }, []);
  return html`<div class="toast-host" role="status" aria-live="polite">
    ${items.map((i) => html`<div key=${i.id} class=${`toast ${i.kind}`}>${i.message}</div>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Misc

export function Switch({ checked, onChange, label }) {
  return html`<label class="switch" title=${label}>
    <input type="checkbox" role="switch" aria-label=${label} checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
    <span></span>
  </label>`;
}

/** Text input that commits on blur / Enter and reverts on Escape. */
export function InlineInput({ value, placeholder, onCommit, class: cls = 'input bare', ...rest }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    if (draft !== value) onCommit(draft);
  };
  return html`<input
    class=${cls}
    value=${draft}
    placeholder=${placeholder}
    onFocus=${() => setFocused(true)}
    onInput=${(e) => setDraft(e.target.value)}
    onBlur=${commit}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') {
        setDraft(value);
        setTimeout(() => e.target.blur());
      }
    }}
    ...${rest}
  />`;
}

// Drag & drop payload helpers (custom MIME types keep drops scoped to our own items).
export const DND = { tab: 'application/x-ow-tab', resource: 'application/x-ow-resource', workspace: 'application/x-ow-workspace' };

export function setDrag(e, type, data) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(type, JSON.stringify(data));
  if (data.url) e.dataTransfer.setData('text/uri-list', data.url);
}

export function getDrag(e, type) {
  try {
    const raw = e.dataTransfer.getData(type);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const hasDrag = (e, type) => e.dataTransfer?.types?.includes(type);
