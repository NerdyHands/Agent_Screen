import { runOneHomeExport } from "./onehome-export.js";

const result = await runOneHomeExport();
if (result.success) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
