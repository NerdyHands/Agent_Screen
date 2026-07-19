# onehome-browserbase

Automate a OneHome shared-search CSV export using [Browserbase](https://www.browserbase.com/) and Playwright Core, then sync listings into Airtable via the REST API.

## Requirements

- Node.js 18+
- A Browserbase account with API key and project ID
- A OneHome shared-search URL
- An Airtable base with Personal Access Token (PAT) and the tables/fields described below

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set:

| Variable | Description |
|---|---|
| `BROWSERBASE_API_KEY` | Browserbase API key (Dashboard → API Keys) |
| `BROWSERBASE_PROJECT_ID` | Browserbase project ID (Dashboard → Projects) |
| `ONEHOME_URL` | Full OneHome shared-search URL (keep private) |
| `BROWSERBASE_INSECURE_TLS` | Set to `1` if Browserbase returns `Connection error.` on your network |
| `AIRTABLE_PAT` | Airtable Personal Access Token with `data.records:read`, `data.records:write`, `schema.bases:read`, and `schema.bases:write` on your base |
| `AIRTABLE_BASE_ID` | Airtable base ID (starts with `app...`) |
| `AIRTABLE_LISTINGS_TABLE` | Listings table name (default: `Listings`) |
| `AIRTABLE_CHANGE_LOG_TABLE` | Change Log table name (default: `Change Log`) |
| `AIRTABLE_MOVED_LIST_TABLE` | Moved List table name (default: `Moved List`) |

## Run

### Export only (OneHome → local CSV)

```bash
npm run export
```

### Sync only (newest CSV in `downloads/` → Airtable)

```bash
npm run sync
```

Optional: pass a specific CSV path:

```bash
node airtable-sync.js "downloads/your-file.csv"
```

### Full pipeline (export then sync)

```bash
npm run pipeline
```

### Create Airtable tables (first-time setup)

Creates **Listings**, **Change Log**, and **Moved List** in your Airtable base with the fields required by the sync script. Requires a PAT with `schema.bases:write` scope.

```bash
npm run setup-airtable
```

Uses `AIRTABLE_BASE_ID` from `.env` (default: `appiNFrRA43MM08Xf`). Override with:

```bash
node create-airtable-tables.js appXXXXXXXXXXXXXX
```

## Export output

On success, export prints JSON like:

```json
{
  "success": true,
  "browserbase_session_id": "session-id-here",
  "csv_file": "C:\\path\\to\\downloads\\onehome-listings-2026-07-08T01-44-39-listings.csv"
}
```

Screenshots are saved in `downloads/` for troubleshooting.

## Sync output

On success, sync prints JSON like:

```json
{
  "success": true,
  "csv_file": "...",
  "csv_rows": 300,
  "existing_airtable_records": 280,
  "new_listings": 20,
  "updated_listings": 12,
  "change_log_records": 8,
  "moved_list_created": 4,
  "moved_list_updated": 2,
  "skipped_unchanged": 268,
  "airtable_api_requests": 15
}
```

## Airtable tables and fields

### Listings

| Field | Source |
|---|---|
| MLS # | CSV `MLS #` |
| Status | CSV `Status` |
| Price | CSV `Price` (number, e.g. `$325,000` → `325000`) |
| Address | CSV `Address` |
| City | CSV `City` |
| Full Address | `{Address}, {City}, VA` |
| Property Type | CSV `Property Type` |
| Beds | CSV `Beds` |
| Baths | CSV `Baths` |
| Square Footage | CSV `Square Footage` |
| Lot Size | CSV `Lot Size` |
| Price per/Sqft | CSV `Price per/Sqft` |
| Utilities | CSV `Utilities` |
| First Seen At | ISO timestamp (new records only) |
| Last Seen At | ISO timestamp (updated records only) |
| Qualification Status | `"new"` for new records |

### Change Log

Created only when **Status** or **Price** changes on an existing listing:

| Field | Value |
|---|---|
| Change Key | `{MLS#}-{YYYYMMDDHHmmss}` |
| MLS # | Listing MLS # |
| Changed At | ISO timestamp |
| Old Status | Previous status |
| New Status | New status |
| Old Price | Previous price |
| New Price | New price |
| Reason | `OneHome status or price changed` |

### Moved List

Upserted for listings with status: Sold, Closed, Off Market, Recently Sold, Withdrawn, Expired.

| Field | Value |
|---|---|
| MLS # | Listing MLS # |
| Status | Current status |
| Price | Current price |
| Full Address | `{Address}, {City}, VA` |
| Moved At | ISO timestamp |

## How sync stays efficient

- **One Airtable read per table** at the start (Listings + Moved List), not per CSV row.
- **Delta detection** by MLS #: only new or changed listings are written.
- **Batch writes** of up to 10 records per Airtable request.
- **Throttling** of 250–350 ms between API calls to reduce rate-limit risk.
- **Change Log** and **Moved List** updates only when relevant fields change.

## CSV parsing

Uses `csv-parse` (RFC 4180) so quoted values with commas (e.g. `"$325,000"`) parse correctly. Rows without an MLS # are skipped.

## Troubleshooting

| Issue | What to check |
|---|---|
| `Connection error.` from Browserbase | Set `BROWSERBASE_INSECURE_TLS=1` in `.env` |
| Export CSV button not found | Screenshots in `downloads/`; confirm list-view URL |
| `No CSV files found` | Run `npm run export` first |
| Airtable 4xx/5xx | Token scopes, base ID, table names, and field names must match exactly |
| `download.saveAs: canceled` | Export uses Browserbase cloud download API (not local `saveAs`) |

Do not paste OneHome URLs, API keys, or PATs into support messages.

## Project files

| File | Purpose |
|---|---|
| `onehome-export.js` | Browserbase export (`runOneHomeExport()`) |
| `airtable-sync.js` | CSV parse + Airtable sync |
| `run-pipeline.js` | Export then sync |
| `run.js` | Thin wrapper around export (backward compatible) |
