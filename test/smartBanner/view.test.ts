import { afterEach, describe, expect, it, vi } from 'vitest';
import { BannerView, HOST_ID } from '../../src/smartBanner/view';
import { bannerConfig } from './fixtures';

function make(position: 'top' | 'bottom' = 'top') {
  const banner = bannerConfig({ position });
  const onClick = vi.fn();
  const onClose = vi.fn();
  const view = new BannerView(document, banner, { onClick, onClose });
  return { view, banner, onClick, onClose };
}

function rect(height: number, bottom: number): DOMRect {
  return { height, bottom, top: bottom - height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) };
}

const css = (name: string) => document.documentElement.style.getPropertyValue(name);

describe('BannerView', () => {
  afterEach(() => {
    document.body.innerHTML = '<p id="content">page</p>';
    vi.restoreAllMocks();
  });

  it('mounts a top banner as the first child of body', () => {
    document.body.innerHTML = '<p id="content">page</p>';
    const { view } = make('top');
    view.mount();
    expect(document.body.firstElementChild?.id).toBe(HOST_ID);
    view.remove();
  });

  it('renders text with textContent and the default link as a real anchor', () => {
    const { view } = make();
    view.mount();
    const root = document.getElementById(HOST_ID)!.shadowRoot!;
    expect(root.querySelector('.title')?.textContent).toBe('Get the app');
    expect(root.querySelector('.subtitle')?.textContent).toBe('Faster checkout');
    const anchor = root.querySelector('a.button') as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe('https://go.example.com/default');
    expect(anchor.getAttribute('target')).toBeNull();
    expect(root.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/icon.png');
    view.remove();
  });

  it('is a labelled region whose close button has a 44px target and a visible focus ring', () => {
    const { view } = make();
    view.mount();
    const root = document.getElementById(HOST_ID)!.shadowRoot!;
    const bar = root.querySelector('.bar')!;
    expect(bar.getAttribute('role')).toBe('region');
    expect(bar.getAttribute('aria-label')).toBe('Get the app');
    // jsdom has no constructed sheets, so the styles land in a <style>.
    const css = root.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.close\s*\{[^}]*width:\s*44px/);
    expect(css).toMatch(/\.close\s*\{[^}]*line-height:\s*44px/);
    expect(css).toMatch(/\.close:focus-visible\s*\{[^}]*outline:/);
    view.remove();
  });

  it('swaps the href', () => {
    const { view } = make();
    view.mount();
    view.setHref('https://go.example.com/p1');
    expect(view.href).toBe('https://go.example.com/p1');
    view.remove();
  });

  it('reports clicks and closes', () => {
    const { view, onClick, onClose } = make();
    view.mount();
    const root = document.getElementById(HOST_ID)!.shadowRoot!;
    const anchor = root.querySelector('a.button') as HTMLAnchorElement;
    anchor.addEventListener('click', (e) => e.preventDefault());
    anchor.click();
    (root.querySelector('button.close') as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.remove();
  });

  it('sets the top variable to the visible height and shrinks it on scroll', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(60, 60));
    const { view } = make('top');
    view.mount();
    expect(css('--grovs-smart-banner-top')).toBe('60px');
    expect(css('--grovs-smart-banner-bottom')).toBe('0px');

    spy.mockReturnValue(rect(60, 20));
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 32));
    expect(css('--grovs-smart-banner-top')).toBe('20px');

    spy.mockReturnValue(rect(60, -40));
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 32));
    expect(css('--grovs-smart-banner-top')).toBe('0px');
    view.remove();
  });

  it('sets the bottom variable for a bottom banner', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(64, 800));
    const { view } = make('bottom');
    view.mount();
    expect(css('--grovs-smart-banner-top')).toBe('0px');
    expect(css('--grovs-smart-banner-bottom')).toBe('64px');
    view.remove();
  });

  it('writes the offset variables only when they change', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(60, 60));
    const { view } = make('top');
    view.mount();
    const set = vi.spyOn(document.documentElement.style, 'setProperty');
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 32));
    expect(set).not.toHaveBeenCalled();
    view.remove();
  });

  it('attaches no scroll listener for a bottom banner', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const { view } = make('bottom');
    view.mount();
    expect(add.mock.calls.some(([type]) => type === 'scroll')).toBe(false);
    view.remove();
  });

  it('removes itself and both variables', () => {
    const { view } = make();
    view.mount();
    view.remove();
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(css('--grovs-smart-banner-top')).toBe('');
    expect(css('--grovs-smart-banner-bottom')).toBe('');
  });
});
