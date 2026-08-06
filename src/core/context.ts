/**
 * Mutable SDK state for one configured client.
 *
 * Unlike the iOS Context this needs no locking — JavaScript is single-threaded
 * per realm — but the same fields live here so the two SDKs stay legible
 * side by side.
 */
export class Context {
  linksquaredId: string | null = null;
  userIdentifier: string | null = null;
  userAttributes: Record<string, unknown> | null = null;
  authenticated = false;

  reset(): void {
    this.linksquaredId = null;
    this.userIdentifier = null;
    this.userAttributes = null;
    this.authenticated = false;
  }
}
