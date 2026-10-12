import { test } from './support/fixtures';
import * as cases from './support/cases';

// The per-change subset: A1 (alert), A2 (modal), B6, C11 (close, key_value), C12 (close button, tap outside).
test.describe('smoke', () => {
  test('A1 alert', ({ host }) => cases.nativeTemplate(host, 'alert'));
  test('A2 html modal', ({ host }) => cases.htmlLayout(host, 'modal'));
  test('B6 over the second route', ({ host }) => cases.overSecondRoute(host));
  test('C11 close action', ({ host }) => cases.closeAction(host));
  test('C11 key_value action', ({ host }) => cases.keyValueAction(host));
  test('C12 close button', ({ host }) => cases.closeButton(host));
  test('C12 tap outside', ({ host }) => cases.tapOutsideCloses(host));
});
