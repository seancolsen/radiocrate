import { StrictMode, useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { installMockApi } from "./harness/mockApi";
import { createStores } from "../stores/createStores";
import { browserEnv, type AppEnv } from "../stores/env";
import { StoresProvider } from "../stores/react";
import "../app.css";

// The shared shell of the dev-only pages that show the app in both themes (the
// kitchen sink and the mockup). Dev-only by construction, like the visual-test
// harness: `vite build` takes `index.html` as its only input.
//
// With no query string a page is a frame holding two copies of itself side by side,
// `?theme=light` and `?theme=dark`. Each copy pins its own `<html data-theme>`,
// so everything in it — portals, the canvas grid, CodeMirror — sees one theme
// exactly as the app would. Either copy also works on its own, full width.

export type Theme = "light" | "dark";

const param = new URLSearchParams(window.location.search).get("theme");
const theme: Theme | null =
  param === "light" || param === "dark" ? param : null;

/** What each copy tells the frame, so the frame can size its iframe to fit. */
interface HeightMessage {
  themedPage: Theme;
  height: number;
}

/** One theme's copy, as tall as its content, so the frame scrolls as one page
 * and the two themes' sections stay side by side. */
function ThemeFrame(props: { theme: Theme }) {
  const [height, setHeight] = useState(1200);
  useEffect(() => {
    const onMessage = (e: MessageEvent<HeightMessage>) => {
      if (e.data?.themedPage === props.theme) setHeight(e.data.height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [props.theme]);
  return (
    <iframe
      title={`${props.theme} theme`}
      src={`?theme=${props.theme}`}
      className="block min-w-0 flex-1 border-0"
      style={{ height }}
    />
  );
}

function SideBySide() {
  return (
    <div className="flex">
      <ThemeFrame theme="light" />
      <ThemeFrame theme="dark" />
    </div>
  );
}

/** Settles this copy into the frame around it, when it's in one.
 *
 * It reports its height whenever that changes, so the frame can size the
 * iframe to fit. Measured off `#root`, not the document: app.css pins `html`
 * and `body` to the viewport's height, which here is the iframe's own — so
 * they'd only ever report back the height they were given.
 *
 * And it lets the wheel through to the frame. Sized to fit, the iframe has
 * nothing to scroll itself, so a wheel over it has to chain up to the frame's
 * page — which app.css's `overscroll-behavior: none` (the app's guard against
 * rubber-banding) would stop dead. */
function fitToFrame(theme: Theme, root: HTMLElement): void {
  if (window.parent === window) return;
  document.documentElement.style.overscrollBehavior = "auto";
  document.body.style.overscrollBehavior = "auto";
  const post = () => {
    const message: HeightMessage = {
      themedPage: theme,
      height: Math.ceil(root.getBoundingClientRect().height),
    };
    window.parent.postMessage(message, window.location.origin);
  };
  new ResizeObserver(post).observe(root);
}

/** The app's real environment, except that nothing persists: these pages
 * share an origin (and so `localStorage`) with the dev server's app, whose
 * open tabs and preferences it must neither read nor overwrite. And it leaves
 * `data-theme` alone, which is this page's to pin. */
function sinkEnv(): AppEnv {
  const backing = new Map<string, string>();
  return {
    ...browserEnv(),
    storage: {
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => void backing.set(key, value),
      removeItem: (key) => void backing.delete(key),
    },
    setDocumentTheme: () => {},
  };
}

/** Mounts a page: the side-by-side frame, or one theme's copy of `Page`. */
export function mountThemedPage(
  title: string,
  Page: (props: { theme: Theme }) => JSX.Element,
): void {
  const rootElement = document.getElementById("root")!;
  const root = createRoot(rootElement);
  if (theme === null) {
    document.title = title;
    root.render(
      <StrictMode>
        <SideBySide />
      </StrictMode>,
    );
    return;
  }
  document.documentElement.setAttribute("data-theme", theme);
  document.title = `${title} (${theme})`;
  // A hot-swapped app.css changes the tokens under everything that paints
  // through CSS on its own; re-setting the attribute is what tells the canvas
  // grid (which listens for `data-theme` changes) to read them again too.
  import.meta.hot?.on("vite:afterUpdate", () =>
    document.documentElement.setAttribute("data-theme", theme),
  );
  installMockApi();
  fitToFrame(theme, rootElement);
  root.render(
    <StrictMode>
      <StoresProvider stores={createStores(sinkEnv())}>
        <Page theme={theme} />
      </StoresProvider>
    </StrictMode>,
  );
}
