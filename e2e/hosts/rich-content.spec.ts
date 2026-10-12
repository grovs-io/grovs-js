import { test } from './support/fixtures';
import { LAYOUTS, NATIVE_TEMPLATES } from './support/definitions';
import * as rich from './support/rich';

// Tests tagged @matrix run on Chromium only (hosts.config.ts); WebKit and Firefox get the rest.
const TEXT_TEMPLATES = NATIVE_TEMPLATES.filter((t) => !t.endsWith('_image'));
const IMAGE_TEMPLATES = NATIVE_TEMPLATES.filter((t) => t.endsWith('_image'));

test.describe('R. rich content', () => {
  for (const design of rich.GALLERY) {
    for (const layout of LAYOUTS) {
      const tag = layout === 'modal' || layout === 'full' ? '' : ' @matrix';
      test(`R1 gallery ${design.id} ${layout} (light desktop, dark phone)${tag}`, ({ host }) => rich.galleryDesign(host, design, layout));
    }
  }
  for (const layout of LAYOUTS) {
    test(`R2 long page ${layout}: scroll inside to the last button`, ({ host }) => rich.longScroll(host, layout));
  }
  test('R3 video autoplays muted inline, loops, has controls', ({ host }) => rich.videoPlays(host));
  test('R3 a broken video leaves the rest of the message closable', ({ host }) => rich.brokenVideo(host));
  test('R3 a big poster image', ({ host }) => rich.bigPoster(host));
  for (const template of TEXT_TEMPLATES) {
    test(`R4 ${template} at its limits (alert: 80/300/30, others: 256/1024/64), colours @matrix`, ({ host }) =>
      rich.nativeAtLimits(host, template));
  }
  for (const template of IMAGE_TEMPLATES) {
    test(`R4 ${template} with https portrait and landscape pictures @matrix`, ({ host }) => rich.imageTemplate(host, template));
  }
  for (const layout of ['full', 'modal', 'banner_bottom']) {
    test(`R5 custom UI ${layout}: web font, animations, fixed bars, text input @matrix`, ({ host }) => rich.customUi(host, layout));
  }
  for (const layout of LAYOUTS) {
    const tag = layout === 'modal' || layout === 'full' ? '' : ' @matrix';
    test(`R6 every kind of button in a long page, ${layout}: each does its job${tag}`, ({ host }) => rich.actionsPage(host, layout));
  }
  for (const template of ['interstitial', 'footer', 'alert']) {
    const tag = template === 'interstitial' ? '' : ' @matrix';
    test(`R7 native ${template}: close, open_url, key_value (5 keys), app-only actions${tag}`, ({ host }) => rich.nativeActions(host, template));
  }
});
