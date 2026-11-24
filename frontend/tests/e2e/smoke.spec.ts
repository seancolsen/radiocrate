import { test, expect, look } from "./fixtures";

// The walking skeleton: the production build, served by the real binary, on
// the pinned sample library.

test("the app boots on the sample library and opens its tracks", async ({
  app,
  page,
}) => {
  await test.step("the explorer lists the library's sources", async () => {
    await expect(app.sources).toMatchAriaSnapshot(`
      - tree "Sources":
        - treeitem "Tracks" [level=1]
        - treeitem "Albums" [level=1]
        - treeitem "Artists" [level=1]
    `);
    await look(page, "explorer");
  });

  await test.step("Tracks opens to every track", async () => {
    await app.openSource("Tracks");
    await expect.poll(() => app.grid.rowCount()).toBe(63);
    await expect(page.getByText("63 tracks", { exact: true })).toBeVisible();
    expect(await app.grid.text()).toMatchSnapshot("tracks.txt");
    await look(page, "tracks");
  });

  await test.step("the assembled app, on real data", async () => {
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("tracks.png");
  });
});
