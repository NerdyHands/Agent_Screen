import "dotenv/config";

import { runOneHomeExport } from "./onehome-export.js";
import { runAirtableSync, writeSyncRunRecord } from "./airtable-sync.js";

async function main() {
  const pipelineSummary = {
    success: false,
    export: null,
    sync: null,
  };

  try {
    const exportResult = await runOneHomeExport();
    pipelineSummary.export = exportResult;

    if (!exportResult.success) {
      throw new Error(exportResult.error ?? "OneHome export failed");
    }

    const syncResult = await runAirtableSync(exportResult.csv_file, {
      source: "pipeline",
    });
    pipelineSummary.sync = syncResult;
    pipelineSummary.success = true;

    console.log(
      JSON.stringify(
        {
          success: true,
          export: exportResult,
          sync: syncResult,
        },
        null,
        2
      )
    );
  } catch (error) {
    pipelineSummary.success = false;
    pipelineSummary.error =
      error instanceof Error ? error.message : String(error);

    // Log failed runs when sync never got to write its own Sync Runs row
    if (!pipelineSummary.sync?.sync_run_written) {
      const syncRun = await writeSyncRunRecord({
        "Run At": new Date().toISOString(),
        Success: false,
        Source: "pipeline",
        "CSV File": pipelineSummary.export?.csv_file
          ? String(pipelineSummary.export.csv_file).split(/[/\\]/).pop()
          : null,
        Error: pipelineSummary.error,
      });
      pipelineSummary.sync_run_written = syncRun.ok && !syncRun.skipped;
      if (!syncRun.ok) {
        pipelineSummary.sync_run_error = syncRun.error;
      }
    }

    console.error(JSON.stringify(pipelineSummary, null, 2));
    process.exitCode = 1;
  }
}

main();
