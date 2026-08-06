/**
 * Sent as the SDK-VERSION header on every request.
 *
 * Matches Constants.Headers.SDKVersion in the iOS APIService so both SDKs
 * report the same generation. The backend does not read this header yet
 * (spec B2) — it is sent for parity and future server-side version gating.
 */
export const SDK_VERSION = '2.0';
