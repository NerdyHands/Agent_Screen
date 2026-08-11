import "dotenv/config";

if (process.env.BROWSERBASE_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

const BATCH_SIZE = 10;
const THROTTLE_MIN_MS = 250;
const THROTTLE_MAX_MS = 350;
const CENSUS_THROTTLE_MS = 150;
const DRY_RUN_SAMPLE_COUNT = 3;
const DEFAULT_STATE = "VA";
const CENSUS_GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

const PENDING_STATUSES = new Set(["pending", "under contract"]);

const SOLD_STATUSES = new Set(["sold", "closed", "recently sold"]);

// Other exit statuses that are neither Pending nor Sold — still tracked in Moved List.
const MOVED_STATUSES = new Set(["off market", "withdrawn", "expired"]);

const UPDATE_FIELDS = [
  "Status",
  "Price",
  "Address",
  "City",
  "Zip",
  "Property Type",
  "Beds",
  "Baths",
  "Square Footage",
  "Lot Size",
  "Utilities",
];

const REQUIRED_ENV = [
  "AIRTABLE_PAT",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_LISTINGS_TABLE",
  "AIRTABLE_CHANGE_LOG_TABLE",
  "AIRTABLE_MOVED_LIST_TABLE",
  "AIRTABLE_PENDING_LIST_TABLE",
  "AIRTABLE_SOLD_LIST_TABLE",
];

let airtableApiRequestCount = 0;

function validateEnv() {
  if (!process.env.AIRTABLE_PAT?.trim() && process.env.AIRTABLE_TOKEN?.trim()) {
    process.env.AIRTABLE_PAT = process.env.AIRTABLE_TOKEN;
  }

  const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

function getConfig() {
  return {
    pat: process.env.AIRTABLE_PAT.trim(),
    baseId: process.env.AIRTABLE_BASE_ID.trim(),
    listingsTable: process.env.AIRTABLE_LISTINGS_TABLE.trim(),
    changeLogTable: process.env.AIRTABLE_CHANGE_LOG_TABLE.trim(),
    movedListTable: process.env.AIRTABLE_MOVED_LIST_TABLE.trim(),
    pendingListTable: process.env.AIRTABLE_PENDING_LIST_TABLE.trim(),
    soldListTable: process.env.AIRTABLE_SOLD_LIST_TABLE.trim(),
    syncRunsTable: (process.env.AIRTABLE_SYNC_RUNS_TABLE || "Sync Runs").trim(),
  };
}

export function isDryRun() {
  return process.env.DRY_RUN === "true";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function cleanPrice(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const digits = String(value).replace(/[^0-9.]/g, "");
  if (!digits) {
    return null;
  }
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cleanNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function stripBomFromHeaders(record) {
  const normalized = {};
  for (const [key, value] of Object.entries(record)) {
    const cleanKey = key.replace(/^\uFEFF/, "").trim();
    normalized[cleanKey] = value;
  }
  return normalized;
}

export function buildFullAddress(address, city, zip, state = DEFAULT_STATE) {
  const street = trimText(address);
  const cityName = trimText(city);
  const zipCode = trimText(zip);
  if (!street || !cityName) {
    return "";
  }
  return zipCode
    ? `${street}, ${cityName}, ${state} ${zipCode}`
    : `${street}, ${cityName}, ${state}`;
}

export function addressCacheKey(address, city, state = DEFAULT_STATE) {
  return `${trimText(address).toLowerCase()}|${trimText(city).toLowerCase()}|${trimText(state).toLowerCase()}`;
}

export function normalizeCsvRow(row) {
  const cleaned = stripBomFromHeaders(row);
  const mls = trimText(cleaned["MLS #"]);
  const address = trimText(cleaned.Address);
  const city = trimText(cleaned.City);
  const status = trimText(cleaned.Status);
  const price = cleanPrice(cleaned.Price);
  const pricePerSqft = cleanPrice(cleaned["Price per/Sqft"]);
  const beds = cleanNumber(cleaned.Beds);
  const baths = cleanNumber(cleaned.Baths);
  const squareFootageRaw = trimText(cleaned["Square Footage"]);
  const squareFootage =
    cleanNumber(squareFootageRaw) ?? (squareFootageRaw || null);
  const lotSizeRaw = trimText(cleaned["Lot Size"]);
  const lotSize = lotSizeRaw || null;
  const utilities = trimText(cleaned.Utilities);

  return {
    mls,
    fields: {
      "MLS #": mls,
      Status: status,
      Price: price,
      Address: address,
      City: city,
      Zip: null,
      "Full Address": buildFullAddress(address, city, null),
      "Property Type": trimText(cleaned["Property Type"]),
      Beds: beds,
      Baths: baths,
      "Square Footage": squareFootage,
      "Lot Size": lotSize,
      "Price per/Sqft": pricePerSqft,
      Utilities: utilities || null,
    },
  };
}

/**
 * Resolve ZIP via US Census geocoder (free, no API key).
 * Returns 5-digit ZIP or null when unmatched / request fails.
 */
export async function lookupZipFromCensus(
  address,
  city,
  state = DEFAULT_STATE
) {
  const street = trimText(address);
  const cityName = trimText(city);
  if (!street || !cityName) {
    return null;
  }

  const oneLine = `${street}, ${cityName}, ${state}`;
  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set("address", oneLine);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const zip = trimText(
      payload?.result?.addressMatches?.[0]?.addressComponents?.zip
    );
    return /^\d{5}(-\d{4})?$/.test(zip) ? zip.slice(0, 5) : null;
  } catch {
    return null;
  }
}

/**
 * Fill Zip (and Full Address) on normalized rows.
 * Reuses existing Airtable Zip when address/city unchanged; otherwise
 * looks up via Census with an in-run address cache.
 */
export async function enrichNormalizedRowsWithZip(
  normalizedRows,
  existingByMls = new Map()
) {
  const cache = new Map();
  let lookups = 0;
  let cacheHits = 0;
  let reusedExisting = 0;
  let unresolved = 0;

  for (const row of normalizedRows) {
    const address = trimText(row.fields.Address);
    const city = trimText(row.fields.City);
    const existing = existingByMls.get(row.mls);
    const existingFields = existing?.fields ?? {};
    const existingZip = trimText(existingFields.Zip) || null;
    const addressUnchanged =
      Boolean(existing) &&
      valuesEqual(existingFields.Address, address) &&
      valuesEqual(existingFields.City, city);

    let zip = null;

    if (addressUnchanged && existingZip) {
      zip = existingZip;
      reusedExisting += 1;
    } else {
      const key = addressCacheKey(address, city);
      if (cache.has(key)) {
        zip = cache.get(key);
        cacheHits += 1;
      } else {
        await sleep(CENSUS_THROTTLE_MS);
        zip = await lookupZipFromCensus(address, city);
        cache.set(key, zip);
        lookups += 1;
      }
    }

    if (!zip) {
      unresolved += 1;
    }

    row.fields.Zip = zip;
    row.fields["Full Address"] = buildFullAddress(address, city, zip);
  }

  return {
    rows: normalizedRows,
    zip_lookups: lookups,
    zip_cache_hits: cacheHits,
    zip_reused_existing: reusedExisting,
    zip_unresolved: unresolved,
  };
}

function valuesEqual(a, b) {
  if (a === null || a === undefined || a === "") {
    return b === null || b === undefined || b === "";
  }
  if (b === null || b === undefined || b === "") {
    return false;
  }
  if (typeof a === "number" || typeof b === "number") {
    const numA = cleanNumber(a);
    const numB = cleanNumber(b);
    if (numA !== null && numB !== null) {
      return numA === numB;
    }
  }
  return String(a).trim() === String(b).trim();
}

function formatChangeKeyTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function isPendingStatus(status) {
  return PENDING_STATUSES.has(trimText(status).toLowerCase());
}

function isSoldStatus(status) {
  return SOLD_STATUSES.has(trimText(status).toLowerCase());
}

function isMovedStatus(status) {
  return MOVED_STATUSES.has(trimText(status).toLowerCase());
}

function hasFieldChanges(existingFields, nextFields) {
  for (const key of UPDATE_FIELDS) {
    if (!valuesEqual(existingFields[key], nextFields[key])) {
      return true;
    }
  }
  return false;
}

export function buildExistingByMls(records) {
  const existingByMls = new Map();
  for (const record of records) {
    const mls = trimText(record.fields?.["MLS #"]);
    if (mls) {
      existingByMls.set(mls, record);
    }
  }
  return existingByMls;
}

export async function findNewestCsvFile(downloadsDir = DOWNLOADS_DIR) {
  let entries;
  try {
    entries = await readdir(downloadsDir);
  } catch {
    throw new Error(`Downloads directory not found: ${downloadsDir}`);
  }

  const csvFiles = entries.filter((name) => name.toLowerCase().endsWith(".csv"));
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found in ${downloadsDir}`);
  }

  const withStats = await Promise.all(
    csvFiles.map(async (name) => {
      const fullPath = path.join(downloadsDir, name);
      const fileStat = await stat(fullPath);
      return { fullPath, mtimeMs: fileStat.mtimeMs };
    })
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].fullPath;
}

export async function parseOneHomeCsv(filePath) {
  const text = await readFile(filePath, "utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });
}

export function normalizeCsvRows(rawRows) {
  const byMls = new Map();
  for (const record of rawRows) {
    const normalized = normalizeCsvRow(record);
    if (!normalized.mls) {
      continue;
    }
    byMls.set(normalized.mls, normalized);
  }
  return [...byMls.values()];
}

// Shared upsert-delta logic for Pending List, Sold List, and Moved List.
// dateFieldName lets each list use its own timestamp column
// ("Went Pending At" / "Sold At" / "Moved At").
function buildStatusListChanges(candidates, existingByMls, dateFieldName) {
  const recordsToCreate = [];
  const recordsToUpdate = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const existing = existingByMls.get(candidate.mls);
    const nextFields = {
      "MLS #": candidate.mls,
      Status: candidate.status,
      Price: candidate.price,
      "Full Address": candidate.fullAddress,
      [dateFieldName]: candidate.at,
    };

    if (!existing) {
      recordsToCreate.push({ fields: nextFields });
      continue;
    }

    const existingFields = existing.fields ?? {};
    const changed =
      !valuesEqual(existingFields.Status, nextFields.Status) ||
      !valuesEqual(existingFields.Price, nextFields.Price) ||
      !valuesEqual(existingFields["Full Address"], nextFields["Full Address"]);

    if (changed) {
      recordsToUpdate.push({ id: existing.id, fields: nextFields });
    } else {
      skipped += 1;
    }
  }

  return { recordsToCreate, recordsToUpdate, skipped };
}

export function buildListingSyncPlan(
  normalizedRows,
  existingByMls,
  existingMovedByMls,
  nowIso = new Date().toISOString(),
  existingPendingByMls = new Map(),
  existingSoldByMls = new Map()
) {
  const recordsToCreate = [];
  const recordsToUpdate = [];
  const changeLogRecordsToCreate = [];
  const movedCandidates = [];
  const pendingCandidates = [];
  const soldCandidates = [];
  let skippedUnchanged = 0;

  for (const row of normalizedRows) {
    const { mls, fields } = row;
    const existing = existingByMls.get(mls);

    // Mutually exclusive: Pending, then Sold, then other exit statuses.
    const candidate = {
      mls,
      status: fields.Status,
      price: fields.Price,
      fullAddress: fields["Full Address"],
      at: nowIso,
    };
    if (isPendingStatus(fields.Status)) {
      pendingCandidates.push(candidate);
    } else if (isSoldStatus(fields.Status)) {
      soldCandidates.push(candidate);
    } else if (isMovedStatus(fields.Status)) {
      movedCandidates.push(candidate);
    }

    // STEP 6: Detect new listings locally
    if (!existing) {
      recordsToCreate.push({
        fields: {
          ...fields,
          "First Seen At": nowIso,
          "Last Seen At": nowIso,
          "Qualification Status": "new",
        },
      });
      continue;
    }

    const existingFields = existing.fields ?? {};
    if (!hasFieldChanges(existingFields, fields)) {
      skippedUnchanged += 1;
      continue;
    }

    // STEP 7: Detect changed listings locally
    const updateFields = { ...fields, "Last Seen At": nowIso };
    recordsToUpdate.push({
      id: existing.id,
      fields: updateFields,
    });

    const statusChanged = !valuesEqual(existingFields.Status, fields.Status);
    const priceChanged = !valuesEqual(existingFields.Price, fields.Price);

    if (statusChanged || priceChanged) {
      const changedAt = new Date();
      changeLogRecordsToCreate.push({
        fields: {
          "Change Key": `${mls}-${formatChangeKeyTimestamp(changedAt)}`,
          "MLS #": mls,
          "Changed At": changedAt.toISOString(),
          "Old Status": existingFields.Status ?? null,
          "New Status": fields.Status ?? null,
          "Old Price": cleanPrice(existingFields.Price),
          "New Price": fields.Price ?? null,
          Reason: "OneHome status or price changed",
        },
      });
    }
  }

  const {
    recordsToCreate: movedListRecordsToCreate,
    recordsToUpdate: movedListRecordsToUpdate,
    skipped: movedListSkipped,
  } = buildStatusListChanges(movedCandidates, existingMovedByMls, "Moved At");

  const {
    recordsToCreate: pendingListRecordsToCreate,
    recordsToUpdate: pendingListRecordsToUpdate,
    skipped: pendingListSkipped,
  } = buildStatusListChanges(
    pendingCandidates,
    existingPendingByMls,
    "Went Pending At"
  );

  const {
    recordsToCreate: soldListRecordsToCreate,
    recordsToUpdate: soldListRecordsToUpdate,
    skipped: soldListSkipped,
  } = buildStatusListChanges(soldCandidates, existingSoldByMls, "Sold At");

  return {
    recordsToCreate,
    recordsToUpdate,
    changeLogRecordsToCreate,
    movedListRecordsToCreate,
    movedListRecordsToUpdate,
    movedListSkipped,
    pendingListRecordsToCreate,
    pendingListRecordsToUpdate,
    pendingListSkipped,
    soldListRecordsToCreate,
    soldListRecordsToUpdate,
    soldListSkipped,
    skippedUnchanged,
  };
}

export function assertReadyForAirtableWrites(state) {
  if (!Array.isArray(state.normalizedRows)) {
    throw new Error(
      "Safety guard failed: normalizedRows must be an array before Airtable writes"
    );
  }
  if (!(state.existingByMls instanceof Map)) {
    throw new Error(
      "Safety guard failed: existingByMls must be a Map before Airtable writes"
    );
  }
  if (!Array.isArray(state.recordsToCreate)) {
    throw new Error(
      "Safety guard failed: recordsToCreate must be an array before Airtable writes"
    );
  }
  if (!Array.isArray(state.recordsToUpdate)) {
    throw new Error(
      "Safety guard failed: recordsToUpdate must be an array before Airtable writes"
    );
  }
  if (!Array.isArray(state.changeLogRecordsToCreate)) {
    throw new Error(
      "Safety guard failed: changeLogRecordsToCreate must be an array before Airtable writes"
    );
  }
}

function sampleRecords(records, count = DRY_RUN_SAMPLE_COUNT) {
  return records.slice(0, count).map((record) =>
    record.id
      ? { id: record.id, fields: record.fields }
      : { fields: record.fields }
  );
}

function logDryRunSamples(plan) {
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        samples: {
          records_to_create: sampleRecords(plan.recordsToCreate),
          records_to_update: sampleRecords(plan.recordsToUpdate),
          change_log_records_to_create: sampleRecords(
            plan.changeLogRecordsToCreate
          ),
          moved_list_records_to_create: sampleRecords(
            plan.movedListRecordsToCreate
          ),
          moved_list_records_to_update: sampleRecords(
            plan.movedListRecordsToUpdate
          ),
          pending_list_records_to_create: sampleRecords(
            plan.pendingListRecordsToCreate
          ),
          pending_list_records_to_update: sampleRecords(
            plan.pendingListRecordsToUpdate
          ),
          sold_list_records_to_create: sampleRecords(
            plan.soldListRecordsToCreate
          ),
          sold_list_records_to_update: sampleRecords(
            plan.soldListRecordsToUpdate
          ),
        },
      },
      null,
      2
    )
  );
}

async function throttle() {
  const delay =
    THROTTLE_MIN_MS +
    Math.floor(Math.random() * (THROTTLE_MAX_MS - THROTTLE_MIN_MS + 1));
  await sleep(delay);
}

export async function airtableRequest(method, tablePath, body) {
  const config = getConfig();
  const url = `https://api.airtable.com/v0/${config.baseId}/${tablePath}`;

  await throttle();

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.pat}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : null;
    const hint =
      cause?.includes("UNABLE_TO_VERIFY") || cause?.includes("certificate")
        ? " Set BROWSERBASE_INSECURE_TLS=1 in .env if you are on a network with SSL inspection."
        : "";
    throw new Error(
      `Airtable request failed: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}${hint}`
    );
  }

  airtableApiRequestCount += 1;

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Airtable ${method} ${tablePath} failed (${response.status}): ${errorBody}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function encodeTablePath(tableName) {
  return encodeURIComponent(tableName);
}

export async function getAllAirtableRecords(tableName) {
  const tablePath = encodeTablePath(tableName);
  const records = [];
  let offset;

  do {
    const query = offset ? `?offset=${encodeURIComponent(offset)}` : "";
    const response = await airtableRequest("GET", `${tablePath}${query}`);
    records.push(...(response.records ?? []));
    offset = response.offset;
  } while (offset);

  return records;
}

export async function createAirtableRecords(tableName, records) {
  if (records.length === 0) {
    return [];
  }

  const tablePath = encodeTablePath(tableName);
  const created = [];

  for (const batch of chunkArray(records, BATCH_SIZE)) {
    const response = await airtableRequest("POST", tablePath, {
      records: batch,
    });
    created.push(...(response.records ?? []));
  }

  return created;
}

export async function updateAirtableRecords(tableName, records) {
  if (records.length === 0) {
    return [];
  }

  const tablePath = encodeTablePath(tableName);
  const updated = [];

  for (const batch of chunkArray(records, BATCH_SIZE)) {
    const response = await airtableRequest("PATCH", tablePath, {
      records: batch,
    });
    updated.push(...(response.records ?? []));
  }

  return updated;
}

// STEP 8: Airtable writes begin here
export async function executeAirtableWrites(plan) {
  const config = getConfig();

  await createAirtableRecords(config.listingsTable, plan.recordsToCreate);
  await updateAirtableRecords(config.listingsTable, plan.recordsToUpdate);
  await createAirtableRecords(
    config.changeLogTable,
    plan.changeLogRecordsToCreate
  );
  await createAirtableRecords(
    config.movedListTable,
    plan.movedListRecordsToCreate
  );
  await updateAirtableRecords(
    config.movedListTable,
    plan.movedListRecordsToUpdate
  );
  await createAirtableRecords(
    config.pendingListTable,
    plan.pendingListRecordsToCreate
  );
  await updateAirtableRecords(
    config.pendingListTable,
    plan.pendingListRecordsToUpdate
  );
  await createAirtableRecords(
    config.soldListTable,
    plan.soldListRecordsToCreate
  );
  await updateAirtableRecords(
    config.soldListTable,
    plan.soldListRecordsToUpdate
  );
}

/**
 * Write one Sync Runs health row. Best-effort: returns { ok, error? }.
 * Skipped entirely when DRY_RUN=true.
 */
export async function writeSyncRunRecord(fields, options = {}) {
  const dryRun = options.dryRun ?? isDryRun();
  if (dryRun) {
    return { ok: true, skipped: true, reason: "dry_run" };
  }

  try {
    validateEnv();
    const config = getConfig();
    const payload = {
      fields: {
        "Run At": fields["Run At"] ?? new Date().toISOString(),
        Success: Boolean(fields.Success),
        Source: fields.Source ?? "sync",
        "CSV File": fields["CSV File"] ?? null,
        "CSV Rows": fields["CSV Rows"] ?? null,
        "Normalized Rows": fields["Normalized Rows"] ?? null,
        Created: fields.Created ?? null,
        Updated: fields.Updated ?? null,
        "Change Log": fields["Change Log"] ?? null,
        "Moved Created": fields["Moved Created"] ?? null,
        "Moved Updated": fields["Moved Updated"] ?? null,
        "Pending Created": fields["Pending Created"] ?? null,
        "Pending Updated": fields["Pending Updated"] ?? null,
        "Sold Created": fields["Sold Created"] ?? null,
        "Sold Updated": fields["Sold Updated"] ?? null,
        Skipped: fields.Skipped ?? null,
        "Zip Lookups": fields["Zip Lookups"] ?? null,
        "Zip Unresolved": fields["Zip Unresolved"] ?? null,
        "API Requests": fields["API Requests"] ?? null,
        Error: fields.Error ?? null,
      },
    };

    const created = await createAirtableRecords(config.syncRunsTable, [
      payload,
    ]);
    return { ok: true, id: created[0]?.id ?? null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSyncRunFieldsFromResult(result, source = "sync") {
  return {
    "Run At": new Date().toISOString(),
    Success: Boolean(result.success),
    Source: source,
    "CSV File": result.csv_file
      ? path.basename(String(result.csv_file))
      : null,
    "CSV Rows": result.csv_rows ?? null,
    "Normalized Rows": result.normalized_rows ?? null,
    Created: result.records_to_create ?? null,
    Updated: result.records_to_update ?? null,
    "Change Log": result.change_log_records_to_create ?? null,
    "Moved Created": result.moved_list_records_to_create ?? null,
    "Moved Updated": result.moved_list_records_to_update ?? null,
    "Pending Created": result.pending_list_records_to_create ?? null,
    "Pending Updated": result.pending_list_records_to_update ?? null,
    "Sold Created": result.sold_list_records_to_create ?? null,
    "Sold Updated": result.sold_list_records_to_update ?? null,
    Skipped: result.skipped_unchanged ?? null,
    "Zip Lookups": result.zip_lookups ?? null,
    "Zip Unresolved": result.zip_unresolved ?? null,
    "API Requests": result.airtable_api_requests ?? null,
    Error: result.error ?? null,
  };
}

export async function syncListingsToAirtable(normalizedRows, options = {}) {
  const config = getConfig();
  const dryRun = options.dryRun ?? isDryRun();
  const existingListings = options.existingListings;
  const existingMovedRecords = options.existingMovedRecords;
  const existingPendingRecords = options.existingPendingRecords;
  const existingSoldRecords = options.existingSoldRecords;

  if (
    !existingListings ||
    !existingMovedRecords ||
    !existingPendingRecords ||
    !existingSoldRecords
  ) {
    throw new Error(
      "syncListingsToAirtable requires existingListings, existingMovedRecords, existingPendingRecords, and existingSoldRecords from step 5"
    );
  }

  const existingByMls = buildExistingByMls(existingListings);
  const existingMovedByMls = buildExistingByMls(existingMovedRecords);
  const existingPendingByMls = buildExistingByMls(existingPendingRecords);
  const existingSoldByMls = buildExistingByMls(existingSoldRecords);

  // Resolve ZIP codes (Census) before local create/update detection
  const zipStats = await enrichNormalizedRowsWithZip(
    normalizedRows,
    existingByMls
  );

  // STEP 6: Detect new listings locally
  // STEP 7: Detect changed listings locally
  const plan = buildListingSyncPlan(
    normalizedRows,
    existingByMls,
    existingMovedByMls,
    new Date().toISOString(),
    existingPendingByMls,
    existingSoldByMls
  );

  assertReadyForAirtableWrites({
    normalizedRows,
    existingByMls,
    recordsToCreate: plan.recordsToCreate,
    recordsToUpdate: plan.recordsToUpdate,
    changeLogRecordsToCreate: plan.changeLogRecordsToCreate,
  });

  const summary = {
    existing_airtable_records: existingListings.length,
    records_to_create: plan.recordsToCreate.length,
    records_to_update: plan.recordsToUpdate.length,
    change_log_records_to_create: plan.changeLogRecordsToCreate.length,
    moved_list_records_to_create: plan.movedListRecordsToCreate.length,
    moved_list_records_to_update: plan.movedListRecordsToUpdate.length,
    pending_list_records_to_create: plan.pendingListRecordsToCreate.length,
    pending_list_records_to_update: plan.pendingListRecordsToUpdate.length,
    sold_list_records_to_create: plan.soldListRecordsToCreate.length,
    sold_list_records_to_update: plan.soldListRecordsToUpdate.length,
    skipped_unchanged: plan.skippedUnchanged,
    zip_lookups: zipStats.zip_lookups,
    zip_cache_hits: zipStats.zip_cache_hits,
    zip_reused_existing: zipStats.zip_reused_existing,
    zip_unresolved: zipStats.zip_unresolved,
    airtable_api_requests: airtableApiRequestCount,
  };

  if (dryRun) {
    logDryRunSamples(plan);
    return {
      dry_run: true,
      ...summary,
      airtable_writes_started_after_comparison: false,
    };
  }

  // STEP 8: Airtable writes begin here
  await executeAirtableWrites(plan);

  return {
    dry_run: false,
    ...summary,
    airtable_writes_started_after_comparison: true,
    airtable_api_requests: airtableApiRequestCount,
  };
}

export async function runAirtableSync(csvFilePath, options = {}) {
  validateEnv();
  airtableApiRequestCount = 0;

  const dryRun = options.dryRun ?? isDryRun();
  const source = options.source ?? "sync";
  const config = getConfig();
  const csvPath = csvFilePath ?? (await findNewestCsvFile());

  // STEP 3: Parse CSV
  const rawRows = await parseOneHomeCsv(csvPath);

  // STEP 4: Normalize rows
  const normalizedRows = normalizeCsvRows(rawRows);

  // STEP 5: Pull existing Airtable Listings once
  const existingListings = await getAllAirtableRecords(config.listingsTable);
  const existingByMls = buildExistingByMls(existingListings);

  // One-time reads of Moved/Pending/Sold lists for local comparison (no writes until step 8)
  const existingMovedRecords = await getAllAirtableRecords(
    config.movedListTable
  );
  const existingPendingRecords = await getAllAirtableRecords(
    config.pendingListTable
  );
  const existingSoldRecords = await getAllAirtableRecords(
    config.soldListTable
  );

  const syncResult = await syncListingsToAirtable(normalizedRows, {
    dryRun,
    existingListings,
    existingMovedRecords,
    existingPendingRecords,
    existingSoldRecords,
  });

  const result = {
    success: true,
    dry_run: dryRun,
    csv_file: csvPath,
    csv_rows: rawRows.length,
    normalized_rows: normalizedRows.length,
    ...syncResult,
  };

  const syncRun = await writeSyncRunRecord(
    buildSyncRunFieldsFromResult(result, source),
    { dryRun }
  );
  result.sync_run_written = syncRun.ok && !syncRun.skipped;
  if (!syncRun.ok) {
    result.sync_run_error = syncRun.error;
  }

  return result;
}

async function main() {
  try {
    const result = await runAirtableSync(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : null;
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      JSON.stringify(
        {
          success: false,
          error: cause ? `${message} (${cause})` : message,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main();
}