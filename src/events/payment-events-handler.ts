import type { GrovsClient } from '../core/client';
import { GrovsError } from '../net/errors';
import { randomUUID } from '../core/uuid';

/** Matches Grovs::Purchases::ALL_EVENTS on the backend. */
export type TransactionType = 'buy' | 'cancel' | 'refund' | 'refund_reversed';

export interface CustomPurchase {
  type: TransactionType;
  priceInCents: number;
  currency: string;
  productID: string;
  startDate?: Date;
  /**
   * Your identifier for the transaction. The backend deduplicates on it, so
   * pass your order or payment id and a retry cannot bill twice. Omitted, the
   * SDK mints one per call, which still covers its own transport retries.
   */
  transactionID?: string;
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
    const date = purchase.startDate ?? new Date();
    if (Number.isNaN(date.getTime())) {
      this.client.log.reportError(
        GrovsError.eventDispatchFailed,
        'logCustomPurchase() was given an invalid startDate; the purchase was not sent.',
      );
      return false;
    }

    const body: Record<string, unknown> = {
      event_type: purchase.type,
      price_cents: purchase.priceInCents,
      currency: purchase.currency,
      product_id: purchase.productID,
      date: date.toISOString(),
      // The backend's dedup key is (transaction_id, event_type, project), and
      // it mints a fresh id server-side when this is blank — so a transport
      // retry of a request the server had already committed would bill the
      // purchase a second time. Minted once here, before the first attempt,
      // it is the same value on every retry.
      transaction_id: purchase.transactionID ?? randomUUID(),
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
