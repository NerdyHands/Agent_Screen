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

  while (Date.now() < endTime) {
    const listResponse = await fetch(
      `${BROWSERBASE_DOWNLOADS_URL}?sessionId=${encodeURIComponent(sessionId)}`,
      {
        headers: { "x-bb-api-key": apiKey },
      }
    );

    if (!listResponse.ok) {
      throw new Error(
        `Browserbase downloads list failed (${listResponse.status} ${listResponse.statusText})`
      );
    }

    const payload = await listResponse.json();
    const downloads = payload.downloads ?? [];

    if (downloads.length > 0) {
      const csvDownload =
        downloads.find((item) => /\.csv$/i.test(item.filename)) ?? downloads[0];

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
        throw new Error(
          `Browserbase download fetch failed (${fileResponse.status} ${fileResponse.statusText})`
        );
      }

      return {
        filename: csvDownload.filename,
        buffer: Buffer.from(await fileResponse.arrayBuffer()),
      };
    }

    await sleep(2_000);
  }

  throw new Error(
    "CSV download did not appear in Browserbase session storage within the retry window."
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
