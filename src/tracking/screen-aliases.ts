import type { ApiService } from '../net/api';
import type { Logger } from '../logging/logger';

/** The backend caps each /screen_aliases request at 200 entries (spec B8). */
const MAX_ALIASES_PER_REQUEST = 200;
const MAX_PATH_LENGTH = 512;
/**
 * `*` compiles to `.*`, and several of them in one pattern backtrack
 * super-linearly on a path that does not match. Measured against a 512-
 * character path: two take 0.2 ms, three 18 ms, four 1.2 s, five a minute.
 * Two is the bound, so the worst case stays imperceptible. `:param` is
 * `[^/]+`, which cannot cross a `/`, so it is unbounded here — express a
 * deeper pattern with parameters.
 */
const MAX_WILDCARDS = 2;

interface CompiledAlias {
  pattern: string;
  alias: string;
  regex: RegExp;
  /** More specific patterns win: more literal text sorts first, and among
   *  equals a `*` costs more than a `:param`. */
  wildcards: number;
  literal: number;
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

  set(aliases: Record<string, string>, logger?: Logger): void {
    this.compiled = Object.entries(aliases)
      .filter(([pattern]) => {
        const stars = (pattern.match(/\*/g) ?? []).length;
        if (stars <= MAX_WILDCARDS) return true;
        logger?.warn(
          `Screen alias "${pattern}" was ignored: over ${MAX_WILDCARDS} "*" ` +
            'wildcards is too slow to match. Use ":name" for inner segments.',
        );
        return false;
      })
      .map(([pattern, alias]) => ({
        pattern,
        alias,
        regex: compile(pattern),
        wildcards: (pattern.match(/:[^/]+|\*/g) ?? []).reduce(
          (sum, token) => sum + (token === '*' ? 2 : 1),
          0,
        ),
        literal: pattern.replace(/:[^/]+|\*/g, '').length,
      }))
      // Literal text first: a bare `*` catch-all must lose to any route
      // pattern however many parameters it has. Wildcard kind breaks ties.
      .sort((a, b) => b.literal - a.literal || a.wildcards - b.wildcards);
  }

  /** Returns the alias for a path, or null when nothing matches. */
  resolve(path: string): string | null {
    // A pattern with several `*` compiles to nested `.*`, which backtracks
    // quadratically or worse on a long non-matching path. No route is this
    // long; the bound keeps the worst case in the microseconds.
    if (path.length > MAX_PATH_LENGTH) return null;
    for (const entry of this.compiled) {
      if (entry.regex.test(path)) return entry.alias;
    }
    return null;
  }

  /** Chunks past the backend's 200-per-request cap. Returns whether every
   *  chunk landed, so callers holding a dirty flag know to retry. */
  async sync(
    api: ApiService,
    logger: Logger,
    abandon: () => boolean = () => false,
  ): Promise<boolean> {
    const rows = this.compiled.map((entry) => ({
      identifier: entry.pattern,
      alias: entry.alias,
    }));

    for (let i = 0; i < rows.length; i += MAX_ALIASES_PER_REQUEST) {
      // Checked per chunk: a reset or disable during the previous request
      // must not be followed by the next one.
      if (abandon()) return false;
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
