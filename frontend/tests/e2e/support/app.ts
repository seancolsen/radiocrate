// The page object: the app as an E2E test drives it. Locators by role and
// accessible name wherever the DOM has them; the results grid, a canvas, is
// read and located through the store facade `?expose=1` puts on the page
// (`AppStoreFacade` in `src/dev/seed.ts`).
//
// Add to this as journeys need more, keeping it to what a user does ("open
// a source", "right-click a row"), not to how a component is built.

import {
  expect,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
import { duringUnload } from "./unload";
import type { AppStoreFacade } from "../../../src/dev/seed";

declare global {
  interface Window {
    __appStore: AppStoreFacade;
  }
}

export class App {
  readonly grid: Grid;

  constructor(readonly page: Page) {
    this.grid = new Grid(page);
  }

  /** Loads the app and waits until it has its list of sources. */
  async load(): Promise<void> {
    await this.page.goto("/?expose=1");
    await this.ready();
  }

  /** Reloads the page, as the user would, and waits for the app again. Tabs
   * and layout come back from `localStorage`; everything else from the server.
   *
   * Waits for the app to settle first, so that what the test did has landed.
   * Anything still in flight that the reload aborts (the lineage analysis's
   * module, say) is logged by the app as an error, which the guards let
   * through while the reload is under way (`support/unload.ts`). */
  async reload(): Promise<void> {
    await this.settled();
    await duringUnload(this.page, () => this.page.reload());
    await this.ready();
  }

  /** Waits until the app has its sources and presets. A new query takes its
   * table's default presets as it opens, so one opened before they land comes
   * up without them (the `test.fail` in `query.spec.ts`). */
  private async ready(): Promise<void> {
    await this.page.waitForFunction(() => {
      const s = window.__appStore?.state;
      return s?.sources.status === "ready" && s.presetsStatus === "ready";
    });
  }

  /** Waits until no page has a query running or a playlist write in flight
   * (a write re-runs its page's query). */
  async settled(): Promise<void> {
    await expect
      .poll(() =>
        this.page.evaluate(() =>
          Object.values(window.__appStore.state.pages).some(
            (p) => p.running || p.writing,
          ),
        ),
      )
      .toBe(false);
  }

  /** The explorer sidebar. */
  get explorer(): Locator {
    return this.page.getByRole("complementary", { name: "Explorer" });
  }

  /** The explorer's tree of sources (saved queries, playlists, folders). */
  get sources(): Locator {
    return this.explorer.getByRole("tree", { name: "Sources" });
  }

  /** A source in the explorer's tree, by its name. */
  source(name: string): Locator {
    return this.sources.getByRole("treeitem", { name, exact: true });
  }

  /** Opens the explorer if it's closed (it closes itself on a narrow window
   * when a source opens). */
  async openExplorer(): Promise<void> {
    const open = this.page.getByRole("button", { name: "Open explorer" });
    if (await open.isVisible()) await open.click();
    await expect(this.explorer).toBeVisible();
  }

  /** Opens a source from the explorer and waits for its first rows. */
  async openSource(name: string): Promise<void> {
    await this.openExplorer();
    await this.source(name).click();
    await expect.poll(() => this.activeTabName()).toBe(name);
    await expect.poll(() => this.grid.rowCount()).not.toBeNull();
  }

  /** The active tab's id, or `null` with none open. */
  activeTabId(): Promise<string | null> {
    return this.page.evaluate(() => window.__appStore.activeTabId());
  }

  /** The active tab's name, or `null` with none open. */
  activeTabName(): Promise<string | null> {
    return this.page.evaluate(() => {
      const s = window.__appStore;
      const id = s.activeTabId();
      return s.state.tabs.find((t) => t.id === id)?.name ?? null;
    });
  }

  /** The page's row count, as the toolbar reads it ("63 tracks"). */
  rowCountLabel(): Locator {
    return this.page.getByText(/^\d[\d,]* \w+$/);
  }
}

/** Resolves with the app's next `/api/rpc` response to a call of `method`.
 * Start it before the action that makes the call. */
export function rpcAnswered(
  page: Page,
  method: string,
  timeout?: number,
): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/rpc" &&
      (r.request().postDataJSON() as { method?: string } | null)?.method ===
        method,
    { timeout },
  );
}

/** Where a row is on screen, in viewport coordinates. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The active tab's results grid. */
export class Grid {
  constructor(private readonly page: Page) {}

  /** The grid's canvas: the one on screen (other tabs' pages stay mounted,
   * hidden). */
  get canvas(): Locator {
    return this.page.locator("canvas").locator("visible=true").first();
  }

  /** How many rows the active tab's results hold; `null` before they land. */
  rowCount(): Promise<number | null> {
    return this.page.evaluate(() => {
      const s = window.__appStore;
      const id = s.activeTabId();
      return id === null ? null : s.rowCount(id);
    });
  }

  /** The active tab's rows as the grid shows them, as text: a line per row,
   * cells separated by tabs. All the rows, or the first `limit`. For
   * `toMatchSnapshot("….txt")`. Throws before the results land. */
  async text(limit?: number): Promise<string> {
    const text = await this.page.evaluate((limit) => {
      const s = window.__appStore;
      const id = s.activeTabId();
      return id === null ? null : s.gridText(id, limit);
    }, limit);
    if (text === null) throw new Error("The active tab has no results yet");
    return `${text}\n`;
  }

  /** Waits until the active tab knows which records its rows are: the
   * lineage analysis, which lands after the rows. The row menu reads it once,
   * as it opens, so until then it offers neither "Edit track" nor "Rate
   * track". {@link Row.openMenu} waits for it. */
  async recordsKnown(): Promise<void> {
    await expect
      .poll(() =>
        this.page.evaluate(() => {
          const s = window.__appStore;
          const id = s.activeTabId();
          return id !== null && s.state.pages[id]?.lineage !== undefined;
        }),
      )
      .toBe(true);
  }

  /** The first row with a cell reading exactly `text`; `null` when none does. */
  find(text: string): Promise<number | null> {
    return this.page.evaluate((text) => {
      const s = window.__appStore;
      const id = s.activeTabId();
      return id === null ? null : s.findRow(id, text);
    }, text);
  }

  /** A row, by its index or by the text of one of its cells. */
  async row(which: number | string): Promise<Row> {
    const index = typeof which === "number" ? which : await this.find(which);
    if (index === null) throw new Error(`No row has a cell reading "${which}"`);
    return new Row(this.page, this, index);
  }
}

/** One row of the grid, scrolled into view before each gesture. */
export class Row {
  constructor(
    private readonly page: Page,
    private readonly grid: Grid,
    readonly index: number,
  ) {}

  /** Scrolls the row into view and returns where it is. */
  async box(): Promise<Box> {
    const box = await this.grid.canvas.evaluate(
      (canvas, row) =>
        window.__appStore.revealRow(canvas as HTMLCanvasElement, row),
      this.index,
    );
    if (!box) throw new Error(`Row ${this.index} isn't in the grid`);
    return box;
  }

  /** A point inside the row, `x` px from its left edge (default: well into
   * its first column), vertically centered. */
  async point(x = 40): Promise<{ x: number; y: number }> {
    const box = await this.box();
    return { x: box.x + x, y: box.y + box.height / 2 };
  }

  async click(options: { modifiers?: ("Shift" | "Control")[] } = {}) {
    const { x, y } = await this.point();
    for (const key of options.modifiers ?? [])
      await this.page.keyboard.down(key);
    await this.page.mouse.click(x, y);
    for (const key of options.modifiers ?? []) await this.page.keyboard.up(key);
  }

  async dblclick() {
    const { x, y } = await this.point();
    await this.page.mouse.dblclick(x, y);
  }

  /** Right-clicks the row, raising its context menu, once the rows' records
   * are known (see {@link Grid.recordsKnown}). */
  async openMenu() {
    await this.grid.recordsKnown();
    const { x, y } = await this.point();
    await this.page.mouse.click(x, y, { button: "right" });
  }
}
