// Core commands retain their historical numeric contract (like agent wait, these
// values overload lib/sk-cli/errors.mjs). Readiness callers inspect them.
export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 2, STATE: 3,
  UNKNOWN_UNIT: 4, GATE: 5, COMMIT: 6, PUSH: 7, REMOTE: 8, CONFLICT: 9,
  DRIFT: 10, VENV: 11, VERIFY: 12 });
import { SidekicksError } from '../sk-cli/errors.mjs';
export class CoreForgeError extends SidekicksError {
  constructor(message, exitCode = EXIT.FAILURE) { super(message); this.name = 'CoreForgeError'; this.exitCode = exitCode; }
}
export class ReleaseExit extends Error {
  constructor(exitCode = 0) { super('release operation completed'); this.exitCode = exitCode; }
}
export function finish(code = 0) { throw new ReleaseExit(code); }
