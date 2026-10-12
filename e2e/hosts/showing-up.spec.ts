import { test } from './support/fixtures';
import { LAYOUTS, NATIVE_TEMPLATES } from './support/definitions';
import * as cases from './support/cases';

test.describe('A. showing up', () => {
  for (const template of NATIVE_TEMPLATES) {
    test(`A1 native ${template} shows its content and counts one view`, ({ host }) => cases.nativeTemplate(host, template));
  }
  for (const layout of LAYOUTS) {
    test(`A2 html ${layout} shows its page with a close button`, ({ host }) => cases.htmlLayout(host, layout));
  }
  test('A3 a full-screen design in a card shows at the largest card size', ({ host }) => cases.fullDesignAsCard(host));
  test('A4 a tiny page keeps a tappable close button', ({ host }) => cases.tinyPageKeepsClose(host));
  test('A5 personalisation fills a default', ({ host }) => cases.personalisationDefault(host));
  test('A5 a missing field with no default skips the message', ({ host }) => cases.personalisationMissing(host));
});
