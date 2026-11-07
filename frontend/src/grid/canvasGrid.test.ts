import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasGrid } from "./canvasGrid";

/** A canvas that accepts every call and draws nothing. */
function fakeCanvas(): HTMLCanvasElement {
  const ctx = new Proxy(
    {},
    {
      get: () => () => ({ width: 0 }),
      set: () => true,
    },
  );
  return {
    width: 0,
    height: 0,
    style: {},
    dataset: {},
    parentElement: null,
    getContext: () => ctx,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  } as unknown as HTMLCanvasElement;
}

describe("CanvasGrid", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A new grid takes over the same canvas when its page is shown again, and
  // when StrictMode remounts it. The old one's repaint, arriving once the fonts
  // load, would paint its own rows over the new one's.
  it("doesn't repaint for fonts that finish loading after it's destroyed", async () => {
    let fontsLoaded = () => {};
    const ready = new Promise<void>((resolve) => (fontsLoaded = resolve));
    vi.stubGlobal("document", {
      fonts: { ready, load: () => ready },
      body: { append: () => {} },
      createElement: () => ({ style: {}, remove: () => {} }),
    });
    vi.stubGlobal("getComputedStyle", () => ({
      fontFamily: "sans-serif",
      getPropertyValue: () => "",
    }));
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const grid = new CanvasGrid(fakeCanvas());
    grid.destroy();
    raf.mockClear();
    fontsLoaded();
    await ready;
    await new Promise((resolve) => setTimeout(resolve));

    expect(raf).not.toHaveBeenCalled();
  });
});
