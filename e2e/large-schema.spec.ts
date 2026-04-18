import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Regression coverage for the "Aw, Snap!" renderer crash that fired
 * whenever the Landing page was mounted with a very-large schema
 * (e.g. GitHub's 72k-line SDL) sitting in localStorage history.
 *
 * The old code path ran `sdlToGraph()` — and thus full graphql-js
 * `parse()` — on every history entry inside `historyMeta` useMemo
 * to compute a type-count summary. That materialized a ~100 MB AST
 * synchronously on mount and, with a few entries in history, took
 * the tab down before any user interaction.
 */

const SCHEMA_PATH = join(here, "..", "schema.docs.graphql");
const largeSchema = readFileSync(SCHEMA_PATH, "utf8");

function hashSdl(sdl: string): string {
  const s = sdl.trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function historyEntriesFor(sdl: string) {
  const now = Date.now();
  const hash = hashSdl(sdl);
  return [
    {
      hash,
      sdl,
      name: "github.graphql",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

async function seedHistory(page: Page, sdl: string) {
  await page.addInitScript((entries) => {
    localStorage.setItem("gompassql:history", JSON.stringify(entries));
  }, historyEntriesFor(sdl));
}

async function getJsHeap(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } })
      .memory;
    return m ? m.usedJSHeapSize : null;
  });
}

async function openHistory(page: Page) {
  await page
    .getByRole("button", { name: /Recent schemas/i })
    .click({ timeout: 10_000 });
}

test.describe("Landing page with large schema in history", () => {
  test("mounts without crashing when history contains a 72k-line SDL", async ({
    page,
  }) => {
    const crashes: string[] = [];
    page.on("crash", () => crashes.push("page crash"));
    page.on("pageerror", (err) => crashes.push(`pageerror: ${err.message}`));

    await seedHistory(page, largeSchema);
    await page.goto("/");

    // Landing shell renders.
    await expect(
      page.getByRole("heading", { name: /Visualize your GraphQL schema/i }),
    ).toBeVisible({ timeout: 10_000 });

    // History trigger lists one entry — implies mount completed.
    await expect(page.getByText(/Recent schemas \(1\)/i)).toBeVisible();

    // Give the renderer a beat to crash if it's going to.
    await page.waitForTimeout(1_500);

    expect(crashes).toEqual([]);

    const heap = await getJsHeap(page);
    if (heap != null) {
      // 200 MB ceiling. Pre-fix the `historyMeta` pass would parse the
      // 72k-line SDL with graphql-js, ballooning the heap by 100+ MB
      // just from the history summary.
      expect(heap).toBeLessThan(200 * 1024 * 1024);
    }
  });

  test("history summary renders via the regex path (no full parse)", async ({
    page,
  }) => {
    await seedHistory(page, largeSchema);
    await page.goto("/");
    await openHistory(page);

    // The summary lives inside the history entry's button. It follows
    // the shape "N types · N enums · N unions · N lines".
    const summary = page.locator("text=/[0-9]+\\s+types.*[0-9]+\\s+lines/i").first();
    await expect(summary).toBeVisible({ timeout: 10_000 });
    const text = (await summary.textContent()) ?? "";
    const typeMatch = /([0-9]+)\s+types/i.exec(text);
    const lineMatch = /([0-9]+)\s+lines/i.exec(text);
    expect(typeMatch).not.toBeNull();
    expect(lineMatch).not.toBeNull();
    // GitHub schema has >1000 object/interface/input definitions and
    // ~72k lines. Exact counts depend on regex scope; we just need
    // order-of-magnitude sanity.
    expect(Number(typeMatch![1])).toBeGreaterThan(500);
    expect(Number(lineMatch![1])).toBeGreaterThan(50_000);
  });
});

test.describe("Large schema end-to-end", () => {
  test.setTimeout(180_000);

  test("loading from history and visualizing renders the canvas", async ({
    page,
  }) => {
    const crashes: string[] = [];
    const consoleLogs: string[] = [];
    page.on("crash", () => crashes.push("page crash"));
    page.on("pageerror", (err) => crashes.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      consoleLogs.push(`${msg.type()}: ${msg.text()}`);
    });

    await seedHistory(page, largeSchema);
    await page.goto("/");

    await openHistory(page);
    await page
      .getByRole("button", { name: /github\.graphql/i })
      .click({ timeout: 10_000 });

    await page
      .getByRole("button", { name: /^Visualize$/ })
      .click({ timeout: 10_000 });

    await page.waitForURL(/\/view/, { timeout: 30_000 });

    // Take heap snapshot before layout completes
    const heapAtView = await getJsHeap(page).catch(() => null);
    console.log(`heap after /view: ${heapAtView ? (heapAtView / 1024 / 1024).toFixed(1) + "MB" : "n/a"}`);

    // Layout-pending overlay may appear. Let it settle.
    const settled = await page
      .getByText(/Laying out/i)
      .first()
      .waitFor({ state: "hidden", timeout: 120_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`layout overlay hidden: ${settled}`);

    const heapAfterLayout = await getJsHeap(page).catch(() => null);
    console.log(
      `heap after layout: ${heapAfterLayout ? (heapAfterLayout / 1024 / 1024).toFixed(1) + "MB" : "n/a"}`,
    );

    const canvasVisible = await page
      .locator("canvas")
      .first()
      .isVisible()
      .catch(() => false);
    console.log(`canvas visible: ${canvasVisible}`);

    // Breathing room for ticker to fire, sprite sweep, drains.
    await page.waitForTimeout(3_000).catch(() => {});

    const heapAtEnd = await getJsHeap(page).catch(() => null);
    console.log(
      `heap after settle: ${heapAtEnd ? (heapAtEnd / 1024 / 1024).toFixed(1) + "MB" : "page closed"}`,
    );

    if (consoleLogs.length) {
      console.log("=== console log trail ===");
      for (const line of consoleLogs) console.log("  " + line);
    }
    expect(crashes).toEqual([]);
    expect(canvasVisible).toBe(true);
  });

  test("panning the canvas after load does not crash", async ({ page }) => {
    const crashes: string[] = [];
    page.on("crash", () => crashes.push("page crash"));
    page.on("pageerror", (err) => crashes.push(`pageerror: ${err.message}`));

    await seedHistory(page, largeSchema);
    await page.goto("/");

    await openHistory(page);
    await page
      .getByRole("button", { name: /github\.graphql/i })
      .click({ timeout: 10_000 });
    await page
      .getByRole("button", { name: /^Visualize$/ })
      .click({ timeout: 10_000 });

    await page.waitForURL(/\/view/, { timeout: 30_000 });

    await page
      .getByText(/Laying out/i)
      .first()
      .waitFor({ state: "hidden", timeout: 120_000 })
      .catch(() => {});

    const canvas = page.locator("canvas").first();
    await canvas.waitFor({ timeout: 15_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Five pan strokes with sub-stroke steps to approximate a real
    // hand drag. Each stroke settles so the motion gate drain runs.
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let s = 0; s < 20; s++) {
        await page.mouse.move(
          cx + ((s * 20 + i * 37) % 400),
          cy + ((s * 15 + i * 23) % 300),
          { steps: 1 },
        );
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
    }

    await page.waitForTimeout(1_000);
    expect(crashes).toEqual([]);
  });
});
