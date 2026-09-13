/** The bits of the browser environment stores read or write directly, injected
 * so store unit tests can pass fakes instead of relying on a DOM (the vitest
 * config runs stores in the `node` environment — see `state management` rule 7
 * in the plan). Everything here is a straight narrowing of a real browser API;
 * `browserEnv()` is what production and the dev harness use. */
export interface AppEnv {
  /** `localStorage`, narrowed to what the persisted-preference helpers need. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** `window.matchMedia`, for the "system" theme's dark/light query. */
  matchMedia: (query: string) => MediaQueryList;
  /** Writes the theme onto the document: `attr` mirrors index.html's pre-paint
   * bootstrap script (`null` clears `data-theme`, otherwise it's set to it), and
   * `themeColor` repoints the single `theme-color` meta so Android tints the
   * status bar behind the clock correctly (see `app/stores/app/theme.ts`). */
  setDocumentTheme: (attr: "light" | "dark" | null, themeColor: string) => void;
}

/** The real browser environment — what `main.tsx` and the dev harness use. */
export function browserEnv(): AppEnv {
  return {
    storage: window.localStorage,
    matchMedia: (query) => window.matchMedia(query),
    setDocumentTheme: (attr, themeColor) => {
      if (attr === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", attr);
      const meta = document.head.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      );
      if (meta) meta.content = themeColor;
    },
  };
}
