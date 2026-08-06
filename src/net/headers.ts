import type { ResolvedConfig } from '../core/config';
import type { Context } from '../core/context';
import { SDK_VERSION } from '../version';

/**
 * Spec B2. The backend reads PROJECT-KEY / project-key in
 * Api::V1::Sdk::BaseController#authenticate_request. v1 sent PROJECT_KEY:
 * Rack folds both to HTTP_PROJECT_KEY so it worked, but nginx ships with
 * underscores_in_headers off and drops underscored headers silently — one
 * proxy config away from a blanket 403.
 */
export function buildHeaders(
  config: ResolvedConfig,
  context: Context,
  identifier: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    PLATFORM: 'web',
    'SDK-VERSION': SDK_VERSION,
    'PROJECT-KEY': config.testEnvironment ? `test_${config.apiKey}` : config.apiKey,
  };

  if (identifier) headers['IDENTIFIER'] = identifier;
  if (context.linksquaredId) headers['LINKSQUARED'] = context.linksquaredId;

  return headers;
}
