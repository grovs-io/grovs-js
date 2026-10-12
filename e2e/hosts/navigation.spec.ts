import { test } from './support/fixtures';
import * as cases from './support/cases';

test.describe('B. where it appears', () => {
  test('B6 over the second route, on top and interactive', ({ host }) => cases.overSecondRoute(host));
  test('B6 while a field has focus, focus returns after closing', ({ host }) => cases.withFieldFocused(host));
  test('B10 survives client-side navigation as a single message', ({ host }) => cases.survivesClientNavigation(host));
  test('B10 a provider remount neither duplicates the message nor counts a second view', ({ host }) => cases.remountNoDuplicate(host));
});
