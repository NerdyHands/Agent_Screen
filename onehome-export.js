import "dotenv/config";

if (process.env.BROWSERBASE_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

const NAVIGATION_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SELECTOR_TIMEOUT_MS = 15_000;
const DOWNLOAD_RETRY_MS = 60_000;
const LOAD_ALL_TIMEOUT_MS = 45_000;
const LOAD_ALL_POLL_MS = 1_000;
const BROWSERBASE_DOWNLOADS_URL = "https://api.browserbase.com/v1/downloads";

const REQUIRED_ENV = [
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "ONEHOME_URL",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

function timestampForFilename() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function findFirstVisible(page, locatorFactories) {
  for (const createLocator of locatorFactories) {
    const locator = createLocator(page);
    try {
      await locator.first().waitFor({ state: "visible", timeout: SELECTOR_TIMEOUT_MS });
      return locator.first();
    } catch {
      // Try next selector fallback.
    }
  }
  return null;
}

async function waitForListingsPage(page) {
  const readyPatterns = [/results/i, /mls\s*#/i, /export to csv/i, /export csv/i];

  for (const pattern of readyPatterns) {
    try {
      await page.getByText(pattern).first().waitFor({
        state: "visible",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return;
    } catch {
      // Try next readiness signal.
    }
  }

  throw new Error(
    "OneHome listings page did not render expected content (Results, MLS #, or Export CSV)."
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function switchToListView(page) {
  const exportButton = page.getByText(/^export to csv$/i).first();

  if (await exportButton.isVisible().catch(() => false)) {
    return false;
  }

  const listToggle = page.locator(
    'input[type="radio"][id^="input-radio-icon-button-"]'
  );

  await listToggle.first().waitFor({
    state: "attached",
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const toggleCount = await listToggle.count();
  if (toggleCount < 3) {
    throw new Error(
      `List view toggle not found. Expected 3 view mode buttons, found ${toggleCount}.`
    );
  }

  const listViewInput = listToggle.nth(2);
  const isChecked = await listViewInput.isChecked().catch(() => false);

  if (!isChecked) {
    await listViewInput.locator("xpath=ancestor::label[1]").click().catch(async () => {
      await listViewInput.evaluate((el) => el.click());
    });
  }

  await exportButton.waitFor({
    state: "visible",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await sleep(1_000);
  return !isChecked;
}

async function readListResultStats(page) {
  return page.evaluate(() => {
    const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const heading = document.querySelector("h2.results");
    const headingText = textOf(heading);

    let total = null;
    let displayedLoaded = null;
    const showingMatch = headingText.match(/showing\s+([\d,]+)\s+of\s+([\d,]+)/i);
    const resultsMatch = headingText.match(/([\d,]+)\s+results?/i);
    if (showingMatch) {
      displayedLoaded = Number(showingMatch[1].replace(/,/g, ""));
      total = Number(showingMatch[2].replace(/,/g, ""));
    } else if (resultsMatch) {
      total = Number(resultsMatch[1].replace(/,/g, ""));
    }

    const table = document.querySelector("table.multi-column-table");
    const bodyRows = table ? table.querySelectorAll("tbody tr").length : 0;
    const allRows = table ? table.querySelectorAll("tr").length : 0;
    const loaded = bodyRows || Math.max(0, allRows - 1);

    const loadMore = [...document.querySelectorAll("button, a")].find((el) => {
      const label = textOf(el);
      return /load\s*more|show\s*more|see\s*more/i.test(label) && el.offsetParent !== null;
    });

    const container = document.querySelector(".properties-tile-container");
    const scrollRoot = container || document.scrollingElement || document.documentElement;

    return {
      headingText,
      total: Number.isFinite(total) ? total : null,
      displayedLoaded: Number.isFinite(displayedLoaded) ? displayedLoaded : null,
      loaded,
      hasLoadMore: Boolean(loadMore),
      scrollHeight: scrollRoot.scrollHeight,
      clientHeight: scrollRoot.clientHeight,
      scrollTop: container ? container.scrollTop : window.scrollY,
    };
  });
}

async function advanceResultsList(page) {
  const action = await page.evaluate(() => {
    const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const loadMore = [...document.querySelectorAll("button, a")].find((el) => {
      const label = textOf(el);
      return /load\s*more|show\s*more|see\s*more/i.test(label) && el.offsetParent !== null;
    });
    if (loadMore) {
      loadMore.click();
      return "load-more";
    }

    const scrollables = [
      document.querySelector(".properties-tile-container"),
      ...document.querySelectorAll("div, main, section"),
    ].filter(Boolean);

    const seen = new Set();
    for (const el of scrollables) {
      if (seen.has(el)) {
        continue;
      }
      seen.add(el);
      const style = getComputedStyle(el);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay") &&
        el.scrollHeight > el.clientHeight + 10
      ) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }

    const container = document.querySelector(".properties-tile-container");
    if (container) {
      container.scrollTo(0, container.scrollHeight);
    }

    window.scrollTo(0, document.documentElement.scrollHeight);
    return "scroll";
  });

  if (action !== "load-more") {
    await page
      .locator("table.multi-column-table tbody tr")
      .last()
      .scrollIntoViewIfNeeded({ timeout: 2_000 })
      .catch(() => {});
  }

  return action;
}

function formatResultCounts(stats) {
  const loaded = stats.displayedLoaded ?? stats.loaded;
  const total = stats.total == null ? "?" : stats.total;
  const heading = stats.headingText ? ` (${stats.headingText})` : "";
  return `${loaded} loaded / ${total} total${heading}`;
}

/**
 * OneHome list view renders an initial batch and lazy-loads the rest
 * by infinite-scrolling `.properties-tile-container`. Export to CSV
 * dumps whatever has been loaded, so we must reach the true bottom first.
 */
async function loadAllListResults(page) {
  const startedAt = Date.now();
  let previousLoaded = -1;
  let stableChecks = 0;
  let stats = await readListResultStats(page);

  console.log(`[onehome-export] Initial list results: ${formatResultCounts(stats)}`);

  while (Date.now() - startedAt < LOAD_ALL_TIMEOUT_MS) {
    const loaded = stats.displayedLoaded ?? stats.loaded;
    const reachedTotal =
      stats.total != null && loaded >= stats.total;

    if (reachedTotal) {
      break;
    }

    const unchanged = loaded === previousLoaded;
    if (previousLoaded !== -1 && unchanged && !stats.hasLoadMore) {
      stableChecks += 1;
      if (stableChecks >= 2) {
        break;
      }
    } else {
      stableChecks = 0;
    }

    previousLoaded = loaded;

    const action = await advanceResultsList(page);
    await sleep(LOAD_ALL_POLL_MS);
    stats = await readListResultStats(page);

    const nextLoaded = stats.displayedLoaded ?? stats.loaded;
    if (nextLoaded !== loaded || stats.hasLoadMore || action === "load-more") {
      console.log(
        `[onehome-export] Loading list results via ${action}: ${formatResultCounts(stats)}`
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const timedOut = elapsedMs >= LOAD_ALL_TIMEOUT_MS;
  const loaded = stats.displayedLoaded ?? stats.loaded;
  const stopReason = timedOut
    ? "hit 45s timeout"
    : stats.total != null && loaded >= stats.total
      ? "loaded count reached heading total"
      : "loaded count stopped increasing";
  console.log(
    `[onehome-export] Pre-export count: ${formatResultCounts(stats)} after ${elapsedMs}ms (${stopReason}; scroll ${stats.scrollTop}/${stats.scrollHeight})`
  );

  return stats;
}

async function findExportCsvButton(page) {
  const exportButton = page.getByText(/^export to csv$/i).first();

  try {
    await exportButton.waitFor({
      state: "visible",
      timeout: SELECTOR_TIMEOUT_MS,
    });
    return exportButton;
  } catch {
    // Fall through to broader selectors.
  }

  const fallback = await findFirstVisible(page, [
    (p) => p.getByRole("button", { name: /export to csv/i }),
    (p) => p.getByText(/export to csv/i),
    (p) => p.locator('button:has-text("Export to CSV")'),
    (p) => p.locator('[aria-label*="Export" i]'),
  ]);
  if (!fallback) {
    throw new Error(
      'Export to CSV button not found. Switch to list view first, then check screenshots in downloads/ and the Browserbase session replay.'
    );
  }

  return fallback;
}

async function configureRemoteDownloads(context, page) {
  const client = await context.newCDPSession(page);
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: "downloads",
    eventsEnabled: true,
  });
}

async function fetchSessionDownload(apiKey, sessionId) {
  const endTime = Date.now() + DOWNLOAD_RETRY_MS;
  let lastError = null;

  while (Date.now() < endTime) {
    try {
      const listResponse = await fetch(
        `${BROWSERBASE_DOWNLOADS_URL}?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: { "x-bb-api-key": apiKey },
        }
      );

      if (!listResponse.ok) {
        lastError = `Browserbase downloads list failed (${listResponse.status} ${listResponse.statusText})`;
        await sleep(2_000);
        continue;
      }

      const payload = await listResponse.json();
      const downloads = payload.downloads ?? [];
      const total = payload.total ?? downloads.length;

      if (total > 0 && downloads.length > 0) {
        const csvDownload =
          downloads.find((item) => /\.csv$/i.test(item.filename)) ??
          downloads[0];

        const fileResponse = await fetch(
          `${BROWSERBASE_DOWNLOADS_URL}/${csvDownload.id}`,
          {
            headers: {
              "x-bb-api-key": apiKey,
              Accept: "application/octet-stream",
            },
          }
        );

        if (!fileResponse.ok) {
          lastError = `Browserbase download fetch failed (${fileResponse.status} ${fileResponse.statusText})`;
          await sleep(2_000);
          continue;
        }

        const buffer = Buffer.from(await fileResponse.arrayBuffer());
        if (buffer.length === 0) {
          lastError = "Browserbase download was empty";
          await sleep(2_000);
          continue;
        }

        return {
          filename: csvDownload.filename,
          buffer,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(2_000);
  }

  throw new Error(
    lastError
      ? `CSV download did not appear in Browserbase session storage within the retry window (${lastError})`
      : "CSV download did not appear in Browserbase session storage within the retry window."
  );
}

async function saveScreenshot(page, filename) {
  const screenshotPath = path.join(DOWNLOADS_DIR, filename);
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  return screenshotPath;
}

/**
 * Run the OneHome Browserbase export and save CSV to downloads/.
 * @returns {Promise<{ success: true, browserbase_session_id: string, csv_file: string } | { success: false, browserbase_session_id: string | null, error: string }>}
 */
export async function runOneHomeExport() {
  validateEnv();

  await mkdir(DOWNLOADS_DIR, { recursive: true });

  const browserbase = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY,
  });

  let session = null;
  let browser = null;
  let page = null;

  try {
    session = await browserbase.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    page = context.pages()[0] ?? (await context.newPage());

    await configureRemoteDownloads(context, page);

    await page.goto(process.env.ONEHOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    await waitForListingsPage(page);
    await sleep(2_000);

    const switchedToListView = await switchToListView(page);

    if (switchedToListView) {
      await saveScreenshot(page, "onehome-list-view.png");
    }

    await loadAllListResults(page);
    await saveScreenshot(page, "onehome-before-export.png");

    const exportButton = await findExportCsvButton(page);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
      exportButton.click(),
    ]);

    const downloadError = await download.failure();
    if (downloadError) {
      throw new Error(`Download failed: ${downloadError}`);
    }

    const suggestedName = sanitizeFilename(
      download.suggestedFilename() || "listings.csv"
    );

    await saveScreenshot(page, "onehome-after-export.png");

    if (browser) {
      await browser.close();
      browser = null;
    }

    const remoteFile = await fetchSessionDownload(
      process.env.BROWSERBASE_API_KEY,
      session.id
    );
    const csvFilename = `onehome-listings-${timestampForFilename()}-${sanitizeFilename(remoteFile.filename || suggestedName)}`;
    const csvPath = path.join(DOWNLOADS_DIR, csvFilename);

    await writeFile(csvPath, remoteFile.buffer);

    return {
      success: true,
      browserbase_session_id: session.id,
      csv_file: csvPath,
      csv_bytes: remoteFile.buffer.length,
    };
  } catch (error) {
    if (page) {
      try {
        await saveScreenshot(page, "onehome-error.png");
      } catch {
        // Ignore screenshot errors during failure handling.
      }
    }

    return {
      success: false,
      browserbase_session_id: session?.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore close errors during cleanup.
      }
    }
  }
}

async function main() {
  const result = await runOneHomeExport();
  if (result.success) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main();
}
