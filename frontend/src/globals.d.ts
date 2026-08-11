/**
 * Build-time constants substituted by Vite's `define` (see `vite.config.ts`).
 * Not real modules — declaring them here keeps this file in global scope.
 */

/**
 * Identifies the frontend build this bundle came from. Compared against the
 * build id the server reports over `app.version` to detect a stale client; they
 * differ exactly when the running client didn't come from the running binary.
 *
 * Unit tests substitute a fixed `"test"` (see `vitest.config.ts`).
 */
declare const __BUILD_ID__: string;
