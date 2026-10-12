import { test } from './support/fixtures';
import * as cases from './support/cases';

test.describe('D. rules', () => {
  test('D16 app_open shows at the start of a visit, once', ({ host }) => cases.appOpenTrigger(host));
  test('D16 screen_view shows on the named screen only', ({ host }) => cases.screenViewTrigger(host));
  test('D16 event filter matches gold, not silver', ({ host }) => cases.eventFilterTrigger(host));
  test('D17 session cap of one', ({ host }) => cases.sessionCap(host));
  test('D17 day cap holds across visits', ({ host }) => cases.capAcrossVisits(host, 'day'));
  test('D17 lifetime cap holds across visits', ({ host }) => cases.capAcrossVisits(host, 'lifetime'));
  test('D17 a 3 s delay shows no earlier than 3 s', ({ host }) => cases.delayedShow(host));
  test('D18 the higher priority of two qualifying messages shows', ({ host }) => cases.priorityWins(host));
});
