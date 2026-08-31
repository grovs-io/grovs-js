import { describe, expect, it, vi } from 'vitest';
import {
  buildStylesheet,
  hostDataAttributes,
  resolveTheme,
} from '../../src/messages/messages-theme';

describe('resolveTheme', () => {
  it('defaults to auto/center with no overrides', () => {
    const t = resolveTheme();
    expect(t.mode).toBe('auto');
    expect(t.position).toBe('center');
    expect(t.overrides).toEqual({});
  });

  it('maps every token to its custom property', () => {
    const t = resolveTheme({
      accentColor: '#e91e63',
      backgroundColor: '#101010',
      textColor: '#fafafa',
      mutedTextColor: '#888',
      borderRadius: '8px',
      fontFamily: 'Georgia, serif',
      backdropColor: 'rgba(0,0,0,.8)',
      zIndex: 5000,
    });
    expect(t.overrides).toEqual({
      '--grovs-accent': '#e91e63',
      '--grovs-bg': '#101010',
      '--grovs-text': '#fafafa',
      '--grovs-muted': '#888',
      '--grovs-radius': '8px',
      '--grovs-font': 'Georgia, serif',
      '--grovs-backdrop': 'rgba(0,0,0,.8)',
      '--grovs-z': '5000',
    });
  });

  it('keeps only the tokens the integrator set', () => {
    const t = resolveTheme({ accentColor: 'red' });
    expect(Object.keys(t.overrides)).toEqual(['--grovs-accent']);
  });

  it('defaults the title and accepts a custom one, rejecting blank', () => {
    expect(resolveTheme().title).toBe('Messages');
    expect(resolveTheme({ title: 'Inbox' }).title).toBe('Inbox');
    expect(resolveTheme({ title: '   ' }).title).toBe('Messages');
  });

  it('accepts valid mode and position', () => {
    const t = resolveTheme({ mode: 'dark', position: 'right' });
    expect(t.mode).toBe('dark');
    expect(t.position).toBe('right');
  });

  it('warns and falls back on an invalid mode or position', () => {
    const warn = vi.fn();
    const t = resolveTheme(
      { mode: 'neon' as never, position: 'bottom' as never },
      warn,
    );
    expect(t.mode).toBe('auto');
    expect(t.position).toBe('center');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops token values carrying CSS delimiters or comments, with a warning', () => {
    const warn = vi.fn();
    const t = resolveTheme(
      { accentColor: 'red;} :host{display:none', backdropColor: 'red /*', textColor: '#fff' },
      warn,
    );
    expect(t.overrides).toEqual({ '--grovs-text': '#fff' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops values CSS.supports rejects, with a warning', () => {
    vi.stubGlobal('CSS', { supports: (_p: string, v: string) => v !== 'notacolor' && v !== 'abc' });
    try {
      const warn = vi.fn();
      const t = resolveTheme({ accentColor: 'notacolor', zIndex: 'abc' as never, textColor: '#fff' }, warn);
      expect(t.overrides).toEqual({ '--grovs-text': '#fff' });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never throws, even on garbage input', () => {
    expect(() => resolveTheme(42 as never)).not.toThrow();
    expect(resolveTheme(42 as never).mode).toBe('auto');
  });
});

describe('hostDataAttributes', () => {
  it('emits nothing for the defaults', () => {
    expect(hostDataAttributes(resolveTheme())).toEqual({});
  });

  it('emits mode and position when forced', () => {
    expect(hostDataAttributes(resolveTheme({ mode: 'dark', position: 'right' }))).toEqual({
      'data-grovs-mode': 'dark',
      'data-grovs-position': 'right',
    });
  });
});

describe('buildStylesheet', () => {
  it('contains the light palette in :host and the dark palette behind the media query', () => {
    const css = buildStylesheet(resolveTheme());
    expect(css).toContain('--grovs-accent: #2563eb');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('--grovs-accent: #60a5fa');
    expect(css).toContain(':host([data-grovs-mode="dark"])');
  });

  it('emits config overrides after the palette so they win in the sheet', () => {
    const css = buildStylesheet(resolveTheme({ accentColor: '#e91e63' }));
    const defaultAt = css.indexOf('--grovs-accent: #2563eb');
    const overrideAt = css.indexOf('--grovs-accent: #e91e63');
    expect(defaultAt).toBeGreaterThanOrEqual(0);
    expect(overrideAt).toBeGreaterThan(defaultAt);
  });

  it('styles the side-sheet position variant', () => {
    expect(buildStylesheet(resolveTheme())).toContain(':host([data-grovs-position="right"])');
  });

  it('respects reduced motion', () => {
    expect(buildStylesheet(resolveTheme())).toContain('@media (prefers-reduced-motion: reduce)');
  });

});
