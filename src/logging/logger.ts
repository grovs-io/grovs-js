import { GrovsError } from '../net/errors';

export type LogLevel = 'info' | 'warn' | 'error';

export type ErrorCallback = (code: GrovsError, message: string) => void;

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

const PREFIX = 'Grovs';

/**
 * Level-filtered logging plus the onError dispatch.
 *
 * Spec A5: every failure path in v1 was a bare console.log, so an integrator
 * could not detect a broken install. Errors now reach the host through
 * onError as well as the console.
 */
export class Logger {
  /** Defaults to error, matching DebugLogger's default on iOS. */
  private level: LogLevel = 'error';
  private onError: ErrorCallback | null = null;
  private readonly reportedOnce = new Set<string>();

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setOnError(callback: ErrorCallback | null): void {
    this.onError = callback;
  }

  info(message: string): void {
    if (RANK[this.level] <= RANK.info) console.info(`${PREFIX} — ${message}`);
  }

  warn(message: string): void {
    if (RANK[this.level] <= RANK.warn) console.warn(`${PREFIX} — ${message}`);
  }

  error(message: string): void {
    if (RANK[this.level] <= RANK.error) console.error(`${PREFIX} — ${message}`);
  }

  /**
   * Logs and notifies the host. A throwing callback is the integrator's bug,
   * but letting it propagate would take down whatever SDK operation was in
   * flight, so it is contained here.
   */
  reportError(code: GrovsError, message: string): void {
    this.error(message);
    if (!this.onError) return;
    try {
      this.onError(code, message);
    } catch {
      this.error('onError callback threw; ignoring');
    }
  }

  /**
   * Reports at most once per key. Used by the SSR no-op (spec A1), where a
   * server-rendered page could otherwise call the same method on every render
   * and flood the log.
   */
  reportErrorOnce(key: string, code: GrovsError, message: string): void {
    if (this.reportedOnce.has(key)) return;
    this.reportedOnce.add(key);
    this.reportError(code, message);
  }

  /** Test seam: clears once-keys so cases do not leak into each other. */
  resetOnceKeys(): void {
    this.reportedOnce.clear();
  }
}
