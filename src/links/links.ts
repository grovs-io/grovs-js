import type { GrovsClient } from '../core/client';
import type { CreateLinkParams } from '../net/api';
import { GrovsError } from '../net/errors';

export class LinkGenerator {
  constructor(private readonly client: GrovsClient) {}

  /**
   * Returns the generated URL, or null on any failure.
   *
   * v1 (grovs_manager.js:151-153) called the error callback when
   * unauthenticated and then issued the request regardless, so a caller could
   * receive an error and a success for one call. Every failure path here
   * returns exactly once.
   */
  async generateLink(params: CreateLinkParams): Promise<string | null> {
    if (!this.client.isEnabled) return null;

    if (!this.client.isAuthenticated()) {
      this.client.log.reportError(
        GrovsError.linkGenerationFailed,
        'The SDK is not authenticated yet; links cannot be generated. ' +
          'Await configure() before calling generateLink().',
      );
      return null;
    }

    const response = await this.client.service.createLink(params);

    if (!response.ok) {
      this.client.log.reportError(
        GrovsError.linkGenerationFailed,
        `Link generation failed with status ${response.status}.`,
      );
      return null;
    }

    const link = (response.body as Record<string, unknown> | null)?.['link'];
    if (typeof link !== 'string' || !link) {
      this.client.log.reportError(
        GrovsError.linkGenerationFailed,
        'The backend returned no link. Configure the redirect rules for this project ' +
          'in the Grovs console first.',
      );
      return null;
    }

    return link;
  }
}
