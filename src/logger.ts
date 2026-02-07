/**
 * Logger wrapper for openclaw-smart-router
 */

interface LoggerLike {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

const PREFIX = "[smart-router]";

let _logger: LoggerLike | null = null;
let _debug = false;

export function initLogger(logger: LoggerLike, debug: boolean): void {
  _logger = logger;
  _debug = debug;
}

function format(msg: string): string {
  return `${PREFIX} ${msg}`;
}

export const log = {
  debug(message: string, ...args: unknown[]): void {
    if (_debug && _logger) {
      _logger.debug(format(message), ...args);
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (_logger) {
      _logger.info(format(message), ...args);
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (_logger) {
      _logger.warn(format(message), ...args);
    }
  },

  error(message: string, err?: unknown): void {
    if (_logger) {
      if (err instanceof Error) {
        _logger.error(format(`${message}: ${err.message}`));
      } else if (err) {
        _logger.error(format(message), err);
      } else {
        _logger.error(format(message));
      }
    }
  },
};
