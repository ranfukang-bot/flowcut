import fs from "node:fs";
import path from "node:path";
import {
  databaseName,
  projectRoot,
  recoveryPath,
  runWrangler,
  wranglerConfigPath,
} from "./cloudflare-common.mjs";

if (!fs.existsSync(recoveryPath) || !fs.existsSync(wranglerConfigPath)) {
  throw new Error("自有授权中心尚未完成部署");
}
const backupDirectory = path.join(projectRoot, "backups");
fs.mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.join(
  backupDirectory,
  `flowcut-license-${timestamp}.sql`,
);
runWrangler([
  "d1",
  "export",
  databaseName,
  "--remote",
  "--skip-confirmation",
  "--output",
  outputPath,
  "--config",
  wranglerConfigPath,
]);
console.log(`授权数据库备份完成：${outputPath}`);
