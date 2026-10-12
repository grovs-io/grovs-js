import { test } from './support/fixtures';
import * as cases from './support/cases';

test.describe('C. interaction', () => {
  test('C11 close action', ({ host }) => cases.closeAction(host));
  test('C11 open_url action', ({ host }) => cases.openUrlAction(host));
  test('C11 key_value action reaches the host callback', ({ host }) => cases.keyValueAction(host));
  test('C11 app-only actions (push, rating, store) are skipped on the web', ({ host }) => cases.appOnlyActionsSkipped(host));
  test('C12 close button', ({ host }) => cases.closeButton(host));
  test('C12 tap outside closes a dismissible message', ({ host }) => cases.tapOutsideCloses(host));
  test('C12 a non-dismissible message stays until its button', ({ host }) => cases.nonDismissibleStays(host));
  test('C12 banner swipe', () => {
    test.skip(true, 'the web renderer has no swipe gesture; a banner closes by its close button');
  });
  test('C13 html bridge: track, setAttribute, close and data-grovs-action', ({ host }) => cases.htmlBridgeCalls(host));
  test('C13 html bridge: open works from a tap', ({ host }) => cases.htmlOpenOnTap(host));
  test('C13 html bridge: open on load is refused (message from app_open, no recent gesture)', ({ host }) => cases.htmlOpenOnLoadRefused(host, 'app_open'));
  test('C13 html bridge: open on load is refused (message from a click trigger)', ({ host }) => cases.htmlOpenOnLoadRefused(host, 'click'));
  test('C14 stars question with comment, thanks and answer callback', ({ host }) => cases.starsQuestion(host));
  test('C14 choice question with thanks and answer callback', ({ host }) => cases.choiceQuestion(host));
  test('C15 html video autoplays muted inline', ({ host }) => cases.htmlVideoPlays(host));
  test('C15 a page never ready within 5 s is skipped', ({ host }) => cases.htmlNeverReadySkipped(host));
});
