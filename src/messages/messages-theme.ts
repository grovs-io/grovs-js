/**
 * Theming for the messages UI. Precedence is page CSS > config > built-in:
 * everything lives in the shadow :host rule, which host-document rules outrank.
 */

export interface MessagesTheme {
  mode?: 'auto' | 'light' | 'dark';
  position?: 'center' | 'right';
  /** Header text of the list view — also the localization hook. */
  title?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  mutedTextColor?: string;
  borderRadius?: string;
  fontFamily?: string;
  backdropColor?: string;
  zIndex?: number;
}

export interface ResolvedMessagesTheme {
  mode: 'auto' | 'light' | 'dark';
  position: 'center' | 'right';
  title: string;
  /** Custom-property name → value, only for tokens the integrator set. */
  overrides: Record<string, string>;
}

/** [config token, custom property, plain property used to validate values] */
const TOKEN_PROPERTIES: ReadonlyArray<[keyof MessagesTheme, string, string]> = [
  ['accentColor', '--grovs-accent', 'color'],
  ['backgroundColor', '--grovs-bg', 'background-color'],
  ['textColor', '--grovs-text', 'color'],
  ['mutedTextColor', '--grovs-muted', 'color'],
  ['borderRadius', '--grovs-radius', 'border-radius'],
  ['fontFamily', '--grovs-font', 'font-family'],
  ['backdropColor', '--grovs-backdrop', 'color'],
  ['zIndex', '--grovs-z', 'z-index'],
];

const MODES = ['auto', 'light', 'dark'] as const;
const POSITIONS = ['center', 'right'] as const;

export function resolveTheme(
  input?: MessagesTheme,
  warn: (message: string) => void = () => {},
): ResolvedMessagesTheme {
  const theme = input && typeof input === 'object' ? input : {};

  let mode: ResolvedMessagesTheme['mode'] = 'auto';
  if (theme.mode !== undefined) {
    if ((MODES as readonly string[]).includes(theme.mode)) mode = theme.mode;
    else warn(`messagesTheme.mode "${String(theme.mode)}" is not auto|light|dark; using auto.`);
  }

  let position: ResolvedMessagesTheme['position'] = 'center';
  if (theme.position !== undefined) {
    if ((POSITIONS as readonly string[]).includes(theme.position)) position = theme.position;
    else {
      warn(`messagesTheme.position "${String(theme.position)}" is not center|right; using center.`);
    }
  }

  const title =
    typeof theme.title === 'string' && theme.title.trim() !== '' ? theme.title : 'Messages';

  const overrides: Record<string, string> = {};
  for (const [token, property, probe] of TOKEN_PROPERTIES) {
    const value = theme[token];
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    // CSS.supports('z-index', 'auto') is true, and `auto` drops the modal
    // behind any positioned content on the page — so the probe below cannot
    // be what rejects it.
    if (token === 'zIndex' && !Number.isInteger(Number(text))) {
      warn(`messagesTheme.zIndex "${text}" is not an integer and was ignored.`);
      continue;
    }
    // Interpolated into the stylesheet; delimiters smuggle rules, '/*' eats the rest of it.
    if (/[;{}]|\/\*/.test(text)) {
      warn(`messagesTheme.${token} contains CSS delimiters and was ignored.`);
      continue;
    }
    // An unparseable value would void the property at computed-value time (e.g.
    // z-index: auto puts the modal behind the page), breaking the documented
    // "a theme never breaks the modal" guarantee.
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports(probe, text)) {
      warn(`messagesTheme.${token} value "${text}" is not valid CSS and was ignored.`);
      continue;
    }
    overrides[property] = text;
  }

  return { mode, position, title, overrides };
}

export function hostDataAttributes(theme: ResolvedMessagesTheme): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (theme.mode !== 'auto') attrs['data-grovs-mode'] = theme.mode;
  if (theme.position !== 'center') attrs['data-grovs-position'] = theme.position;
  return attrs;
}

const LIGHT = `
  --grovs-accent: #2563eb;
  --grovs-bg: #ffffff;
  --grovs-text: #1a1d21;
  --grovs-muted: #6b7280;
  --grovs-backdrop: rgba(0,0,0,.45);
`;

const DARK = `
  --grovs-accent: #60a5fa;
  --grovs-bg: #1c1f24;
  --grovs-text: #e7e9ec;
  --grovs-muted: #9aa2ad;
  --grovs-backdrop: rgba(0,0,0,.6);
`;

const SHARED = `
  --grovs-radius: 12px;
  --grovs-font: system-ui, -apple-system, sans-serif;
  --grovs-z: 1000;
  --grovs-hairline: color-mix(in srgb, var(--grovs-text) 12%, transparent);
  --grovs-hover: color-mix(in srgb, var(--grovs-text) 7%, transparent);
`;

export function buildStylesheet(theme: ResolvedMessagesTheme): string {
  const overrideLines = Object.entries(theme.overrides)
    .map(([property, value]) => `  ${property}: ${value};`)
    .join('\n');

  // Repeated into every mode block rather than emitted once at bare :host.
  // The dark rules are :host(<selector>), which outranks a plain :host on
  // specificity, so a single override block loses in dark mode however late it
  // appears — the configured colors would apply in light mode and be silently
  // ignored in dark.
  const overrides = overrideLines === '' ? '' : `\n${overrideLines}\n`;

  return `
:host { ${LIGHT} ${SHARED}${overrides} }
@media (prefers-color-scheme: dark) {
  :host(:not([data-grovs-mode="light"])) { ${DARK}${overrides} }
}
:host([data-grovs-mode="dark"]) { ${DARK}${overrides} }

.grovs-backdrop, .grovs-backdrop * { box-sizing: border-box; }
.grovs-backdrop {
  position: fixed; inset: 0;
  z-index: var(--grovs-z);
  background: var(--grovs-backdrop);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--grovs-font);
  color: var(--grovs-text);
}
.grovs-card {
  background: var(--grovs-bg);
  border-radius: var(--grovs-radius);
  border: 1px solid var(--grovs-hairline);
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
  width: min(420px, calc(100vw - 32px));
  height: min(560px, 70vh);
  display: flex; flex-direction: column;
  overflow: hidden;
  animation: grovs-in 150ms ease-out;
}
.grovs-detail-card {
  width: min(720px, calc(100vw - 32px));
  height: min(80vh, 900px);
}
:host([data-grovs-position="right"]) .grovs-backdrop { justify-content: flex-end; align-items: stretch; }
:host([data-grovs-position="right"]) .grovs-card {
  height: 100%; border-radius: 0; border: none; width: min(400px, 100vw);
}
@keyframes grovs-in { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .grovs-card { animation: none; } }
@media (max-width: 480px) {
  .grovs-card, .grovs-detail-card { width: 100vw; height: 100dvh; border-radius: 0; border: none; }
}

.grovs-header {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--grovs-hairline);
  flex-shrink: 0;
}
.grovs-heading { font-weight: 600; font-size: 16px; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grovs-badge {
  background: var(--grovs-accent); color: #fff;
  font-size: 12px; font-weight: 600;
  border-radius: 10px; padding: 1px 8px;
}
.grovs-badge[data-count="0"] { display: none; }
.grovs-close {
  background: transparent; border: none; color: var(--grovs-muted);
  cursor: pointer; font-size: 16px; padding: 4px 6px; border-radius: 4px;
}
.grovs-close:hover { background: var(--grovs-hover); color: var(--grovs-text); }
.grovs-close:focus-visible { outline: 2px solid var(--grovs-accent); }

.grovs-item-list { overflow-y: auto; flex: 1; }
.grovs-item {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--grovs-hairline);
  cursor: pointer;
}
.grovs-item:hover { background: var(--grovs-hover); }
.grovs-item:focus-visible { outline: 2px solid var(--grovs-accent); outline-offset: -2px; }
.grovs-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--grovs-accent);
  margin-top: 6px; flex-shrink: 0;
}
.grovs-item[data-read="true"] .grovs-dot { visibility: hidden; }
.grovs-item-title { font-weight: 600; font-size: 14px; display: block; }
.grovs-item-subtitle {
  color: var(--grovs-muted); font-size: 13px; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}

.grovs-empty {
  padding: 48px 16px; text-align: center; color: var(--grovs-muted); font-size: 14px;
}
.grovs-empty svg { display: block; margin: 0 auto 12px; opacity: .5; }

.grovs-skeleton { padding: 14px 16px; border-bottom: 1px solid var(--grovs-hairline); }
.grovs-skeleton div {
  height: 12px; border-radius: 4px; background: var(--grovs-hover);
  animation: grovs-pulse 1.2s ease-in-out infinite;
}
.grovs-skeleton div + div { margin-top: 8px; width: 60%; }
@keyframes grovs-pulse { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .grovs-skeleton div { animation: none; } }

.grovs-frame { width: 100%; flex: 1; border: none; }
`;
}
