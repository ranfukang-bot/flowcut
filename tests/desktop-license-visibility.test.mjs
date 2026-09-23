import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const source = (file) => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
test("personal desktop displays its version without account expiry or license login", () => {
  const studio = source("app/studio-app.tsx");
  const main = source("gemini-web-workbench/src/main.js");
  assert.match(studio, /个人本机版/);
  assert.match(studio, /version-badge/);
  assert.doesNotMatch(studio, /licenseLogout|licenseDisplay|有效至/);
  assert.doesNotMatch(main, /LicenseClient|UpdateManager|authorizeExecution|showLicenseScreen/);
  assert.match(main, /await activateWorkbench\(\)/);
});
