import type { ApiService } from '../net/api';
import type { Logger } from '../logging/logger';

/** The backend caps each /screen_aliases request at 200 entries (spec B8). */
const MAX_ALIASES_PER_REQUEST = 200;

interface CompiledAlias {
  pattern: string;
  alias: string;
  regex: RegExp;
  /** More specific patterns win, so fewer wildcards sorts first. */
  wildcards: number;
}

/**
 * Maps URL paths to friendly screen names, with pattern support.
 *
 * iOS aliases map class names, which are inherently low-cardinality. URLs are
 * not: `/product/1`, `/product/2`, `/product/3` are three screens to a naive
 * mapping and one screen to a person. Without pattern collapsing, a catalogue
 * of any size floods the dashboard with rows nobody can read.
 */
export class ScreenAliases {
  private compiled: CompiledAlias[] = [];

  set(aliases: Record<string, string>): void {
    this.compiled = Object.entries(aliases)
      .map(([pattern, alias]) => ({
        pattern,
        alias,
        regex: compile(pattern),
        wildcards: (pattern.match(/:[^/]+|\*/g) ?? []).length,
      }))
      .sort((a, b) => a.wildcards - b.wildcards);
  }

  /** Returns the alias for a path, or null when nothing matches. */
  resolve(path: string): string | null {
    for (const entry of this.compiled) {
      if (entry.regex.test(path)) return entry.alias;
    }
    return null;
  }

  /** Chunks past the backend's 200-per-request cap. Returns whether every
   *  chunk landed, so callers holding a dirty flag know to retry. */
  async sync(api: ApiService, logger: Logger): Promise<boolean> {
    const rows = this.compiled.map((entry) => ({
      identifier: entry.pattern,
      alias: entry.alias,
    }));

    for (let i = 0; i < rows.length; i += MAX_ALIASES_PER_REQUEST) {
      const chunk = rows.slice(i, i + MAX_ALIASES_PER_REQUEST);
      const response = await api.syncScreenAliases(chunk);
      if (!response.ok) {
        logger.warn(`Could not sync ${chunk.length} screen alias(es) to the dashboard.`);
        return false;
      }
    }
    return true;
  }
}

/**
 * Compiles `/product/:id` and `/docs/*` into anchored regexes.
 *
 * Everything outside a wildcard is escaped, so a path containing regex
 * metacharacters cannot alter the match — or, with a hostile alias map, turn
 * a lookup into catastrophic backtracking.
 */
function compile(pattern: string): RegExp {
  const source = pattern
    .split(/(:[^/]+|\*)/)
    .map((part) => {
      if (part === '*') return '.*';
      if (part.startsWith(':')) return '[^/]+';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');

  return new RegExp(`^${source}/?$`);
}
