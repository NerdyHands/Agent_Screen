import "dotenv/config";

import { runOneHomeExport } from "./onehome-export.js";
import { runAirtableSync } from "./airtable-sync.js";

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

    const syncResult = await runAirtableSync(exportResult.csv_file);
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

    console.error(JSON.stringify(pipelineSummary, null, 2));
    process.exitCode = 1;
  }
}

main();
