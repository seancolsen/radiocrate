import { vi } from "vitest";
import type { AppEnv } from "../env";

/** A fake {@link AppEnv} for store unit tests: an in-memory `storage`, a
 * `matchMedia` that always reports light/no-match (tests that care about dark
 * mode pass their own), and a `setDocumentTheme` spy instead of a real DOM
 * (vitest runs these tests in the `node` environment — see
 * `vitest.config.ts`). */
export function fakeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  const backing = new Map<string, string>();
  return {
    storage: {
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => {
        backing.set(key, value);
      },
      removeItem: (key) => {
        backing.delete(key);
      },
    },
    matchMedia: vi.fn(
      () =>
        ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    ),
    setDocumentTheme: vi.fn(),
    ...overrides,
  };
}
