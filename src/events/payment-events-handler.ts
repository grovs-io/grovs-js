import type { GrovsClient } from '../core/client';
import { GrovsError } from '../net/errors';

/** Matches Grovs::Purchases::ALL_EVENTS on the backend. */
export type TransactionType = 'buy' | 'cancel' | 'refund' | 'refund_reversed';

export interface CustomPurchase {
  type: TransactionType;
  priceInCents: number;
  currency: string;
  productID: string;
  startDate?: Date;
}

/**
 * Custom purchase events.
 *
 * There is no logInAppPurchase counterpart: StoreKit has no web equivalent,
 * and every web payment flow is a custom transaction.
 */
export class PaymentEventsHandler {
  constructor(private readonly client: GrovsClient) {}

  async logCustomPurchase(purchase: CustomPurchase): Promise<boolean> {
    if (!this.client.isEnabled) return false;

    if (!this.client.isAuthenticated()) {
      this.client.reportUnavailable(
        'logCustomPurchase',
        GrovsError.eventDispatchFailed,
        'The SDK is not authenticated yet; purchase events cannot be sent.',
      );
      return false;
    }

    // Wire names match iOS's TransactionData.toData() and the backend's
    // payment_event_params permit list: event_type / price_cents / date.
    const body: Record<string, unknown> = {
      event_type: purchase.type,
      price_cents: purchase.priceInCents,
      currency: purchase.currency,
      product_id: purchase.productID,
      date: (purchase.startDate ?? new Date()).toISOString(),
    };

    const response = await this.client.service.addPaymentEvent(body);

    // Spec B4: routes.rb mounts sdk/add_payment_event inside
    // `if ENV.fetch("GROVS_EE", "false") == "true"`, so on a standard
    // deployment the route does not exist. Retrying a 404 forever against a
    // route that will never appear is the failure mode worth naming, so this
    // reports once with the reason and gives up.
    if (response.status === 404) {
      this.client.log.reportError(
        GrovsError.eventDispatchFailed,
        'Payment events require a Grovs Enterprise deployment (GROVS_EE=true); ' +
          'the endpoint is not available on this backend. The event was not sent and ' +
          'will not be retried.',
      );
      return false;
    }

    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.eventDispatchFailed,
        `Payment event failed with status ${response.status}.`,
      );
      return false;
    }

    return true;
  }
}
