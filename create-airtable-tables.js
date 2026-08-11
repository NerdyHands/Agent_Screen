import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.BROWSERBASE_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const DEFAULT_BASE_ID = "appiNFrRA43MM08Xf";
const META_API_BASE = "https://api.airtable.com/v0/meta/bases";

const TABLE_DEFINITIONS = [
  {
    name: "Listings",
    description: "Active OneHome listings synced from CSV export",
    fields: [
      { name: "MLS #", type: "singleLineText" },
      { name: "Status", type: "singleLineText" },
      {
        name: "Price",
        type: "currency",
        options: { precision: 0, symbol: "$" },
      },
      { name: "Address", type: "singleLineText" },
      { name: "City", type: "singleLineText" },
      { name: "Zip", type: "singleLineText" },
      { name: "Full Address", type: "singleLineText" },
      { name: "Property Type", type: "singleLineText" },
      { name: "Beds", type: "number", options: { precision: 0 } },
      { name: "Baths", type: "number", options: { precision: 1 } },
      { name: "Square Footage", type: "number", options: { precision: 0 } },
      { name: "Lot Size", type: "singleLineText" },
      {
        name: "Price per/Sqft",
        type: "number",
        options: { precision: 0 },
      },
      { name: "Utilities", type: "singleLineText" },
      {
        name: "First Seen At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
      {
        name: "Last Seen At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
      { name: "Qualification Status", type: "singleLineText" },
    ],
  },
  {
    name: "Change Log",
    description: "Status and price changes detected during OneHome sync",
    fields: [
      { name: "Change Key", type: "singleLineText" },
      { name: "MLS #", type: "singleLineText" },
      {
        name: "Changed At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
      { name: "Old Status", type: "singleLineText" },
      { name: "New Status", type: "singleLineText" },
      {
        name: "Old Price",
        type: "currency",
        options: { precision: 0, symbol: "$" },
      },
      {
        name: "New Price",
        type: "currency",
        options: { precision: 0, symbol: "$" },
      },
      { name: "Reason", type: "singleLineText" },
    ],
  },
  {
    name: "Moved List",
    description:
      "Withdrawn, expired, and off-market listings from OneHome (not Pending or Sold)",
    fields: [
      { name: "MLS #", type: "singleLineText" },
      { name: "Status", type: "singleLineText" },
      {
        name: "Price",
        type: "currency",
        options: { precision: 0, symbol: "$" },
      },
      { name: "Full Address", type: "singleLineText" },
      {
        name: "Moved At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
    ],
  },
  {
    name: "Pending List",
    description: "Listings currently Pending / Under Contract",
    fields: [
      { name: "MLS #", type: "singleLineText" },
      { name: "Status", type: "singleLineText" },
      {
        name: "Price",
        type: "currency",
        options: { precision: 0, symbol: "$" },
      },
      { name: "Full Address", type: "singleLineText" },
      {
        name: "Went Pending At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
    ],
  },
  {
    name: "Sold List",
    description: "Listings that have Sold, Closed, or gone Recently Sold",
    fields: [
      { name: "MLS #", type: "singleLineText" },
      { name: "Status", type: "singleLineText" },
      {
        name: "Price",
        type: "currency",
        options: { precision: 0, symbol: "$" },
      },
      { name: "Full Address", type: "singleLineText" },
      {
        name: "Sold At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
    ],
  },
  {
    name: "Sync Runs",
    description: "One row per export/sync run for pipeline health monitoring",
    fields: [
      {
        name: "Run At",
        type: "dateTime",
        options: dateTimeOptions(),
      },
      {
        name: "Success",
        type: "checkbox",
        options: { color: "greenBright", icon: "check" },
      },
      { name: "Source", type: "singleLineText" },
      { name: "CSV File", type: "singleLineText" },
      {
        name: "CSV",
        type: "multipleAttachments",
      },
      { name: "CSV Rows", type: "number", options: { precision: 0 } },
      { name: "Normalized Rows", type: "number", options: { precision: 0 } },
      { name: "Created", type: "number", options: { precision: 0 } },
      { name: "Updated", type: "number", options: { precision: 0 } },
      { name: "Change Log", type: "number", options: { precision: 0 } },
      { name: "Moved Created", type: "number", options: { precision: 0 } },
      { name: "Moved Updated", type: "number", options: { precision: 0 } },
      { name: "Pending Created", type: "number", options: { precision: 0 } },
      { name: "Pending Updated", type: "number", options: { precision: 0 } },
      { name: "Sold Created", type: "number", options: { precision: 0 } },
      { name: "Sold Updated", type: "number", options: { precision: 0 } },
      { name: "Skipped", type: "number", options: { precision: 0 } },
      { name: "Zip Lookups", type: "number", options: { precision: 0 } },
      { name: "Zip Unresolved", type: "number", options: { precision: 0 } },
      { name: "API Requests", type: "number", options: { precision: 0 } },
      { name: "Error", type: "multilineText" },
    ],
  },
];

function dateTimeOptions() {
  return {
    timeZone: "America/New_York",
    dateFormat: { name: "iso" },
    timeFormat: { name: "24hour" },
  };
}

function getPat() {
  const pat = process.env.AIRTABLE_PAT?.trim() || process.env.AIRTABLE_TOKEN?.trim();
  if (!pat) {
    throw new Error(
      "Missing AIRTABLE_PAT (or AIRTABLE_TOKEN) in .env. Token needs schema.bases:write scope."
    );
  }
  return pat;
}

function getBaseId() {
  return (
    process.argv[2]?.trim() ||
    process.env.AIRTABLE_BASE_ID?.trim() ||
    DEFAULT_BASE_ID
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function metaRequest(pat, method, path, body) {
  await sleep(300);

  const response = await fetch(`${META_API_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const hint =
      response.status === 403
        ? " Ensure your PAT has schema.bases:read and schema.bases:write scopes and access to this base."
        : "";
    throw new Error(
      `Airtable ${method} ${path} failed (${response.status}): ${text}${hint}`
    );
  }

  return payload;
}

async function getBaseSchema(pat, baseId) {
  const payload = await metaRequest(pat, "GET", `${baseId}/tables`);
  return payload.tables ?? [];
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

async function createTable(pat, baseId, definition) {
  const payload = await metaRequest(pat, "POST", `${baseId}/tables`, {
    name: definition.name,
    description: definition.description,
    fields: definition.fields,
  });

  return {
    action: "created_table",
    table: definition.name,
    tableId: payload.id,
    fields: definition.fields.map((field) => field.name),
  };
}

async function addMissingFields(pat, baseId, table, definition) {
  const existingNames = new Set(
    (table.fields ?? []).map((field) => normalizeName(field.name))
  );

  const missing = definition.fields.filter(
    (field) => !existingNames.has(normalizeName(field.name))
  );

  if (missing.length === 0) {
    return {
      action: "skipped_table",
      table: definition.name,
      tableId: table.id,
      reason: "Table already exists with all required fields",
    };
  }

  const added = [];
  for (const field of missing) {
    const created = await metaRequest(
      pat,
      "POST",
      `${baseId}/tables/${table.id}/fields`,
      field
    );
    added.push(created.name ?? field.name);
  }

  return {
    action: "added_fields",
    table: definition.name,
    tableId: table.id,
    fields_added: added,
  };
}

export async function setupAirtableTables(baseId = getBaseId()) {
  const pat = getPat();
  const tables = await getBaseSchema(pat, baseId);
  const tablesByName = new Map(
    tables.map((table) => [normalizeName(table.name), table])
  );

  const results = [];

  for (const definition of TABLE_DEFINITIONS) {
    const existing = tablesByName.get(normalizeName(definition.name));

    if (!existing) {
      results.push(await createTable(pat, baseId, definition));
      continue;
    }

    results.push(await addMissingFields(pat, baseId, existing, definition));
  }

  return {
    success: true,
    base_id: baseId,
    results,
  };
}

async function main() {
  try {
    const summary = await setupAirtableTables();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : null;

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

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}