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
   * status bar behind the clock correctly (see `stores/app/theme.ts`). */
  setDocumentTheme: (attr: "light" | "dark" | null, themeColor: string) => void;
  /** `navigator.clipboard.writeText`. Called synchronously from the click
   * that asks for it: Safari only lets a gesture's own call stack write. */
  writeClipboardText: (text: string) => Promise<void>;
  /** Offers `text` to the user as a file named `name`, to be saved where they
   * choose. Resolves `false` when they decline (cancel the save dialog). Called
   * synchronously from the click that asks for it, like
   * {@link AppEnv.writeClipboardText}: the save dialog needs the gesture too. */
  saveTextFile: (name: string, text: string, type: string) => Promise<boolean>;
}

/** The File System Access API's save dialog, which TypeScript's DOM library
 * doesn't declare yet — and which only Chromium has. */
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** Saves `text` as `name` through the browser's save dialog where there is one
 * to call (Chromium), so the user picks where it goes. Elsewhere it's a plain
 * download, which asks or doesn't as the browser's own settings say. */
async function saveTextFile(
  name: string,
  text: string,
  type: string,
): Promise<boolean> {
  const blob = new Blob([text], { type });
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    const extension = name.slice(name.lastIndexOf("."));
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: "CSV file", accept: { [type]: [extension] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return false;
      }
      throw err;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoked on a later task, once the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
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
    writeClipboardText: (text) => navigator.clipboard.writeText(text),
    saveTextFile,
  };
}
