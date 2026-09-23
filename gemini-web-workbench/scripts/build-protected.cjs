const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const esbuild = require("esbuild");
const bytenode = require("bytenode");

const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "src");
const outputRoot = path.join(projectRoot, "dist-protected");
const bundlePath = path.join(outputRoot, "main.bundle.cjs");
const bytecodePath = path.join(outputRoot, "main.jsc");

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

for (const preload of ["preload-ui.js"]) {
  esbuild.buildSync({
    entryPoints: [path.join(sourceRoot, preload)],
    outfile: path.join(outputRoot, preload),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    external: ["electron"],
  });
}

esbuild.buildSync({
  entryPoints: [path.join(sourceRoot, "gemini-preload-bridge.js")],
  outfile: path.join(outputRoot, "gemini-preload.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["electron"],
});

esbuild.buildSync({
  entryPoints: [path.join(sourceRoot, "site-runtime-host.cjs")],
  outfile: path.join(outputRoot, "site-runtime-host.cjs"),
  bundle: false,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

fs.copyFileSync(path.join(sourceRoot, "boot.html"), path.join(outputRoot, "boot.html"));

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function filesUnder(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(absolute));
    else output.push(absolute);
  }
  return output;
}

const siteDistRoot = path.resolve(projectRoot, "..", "dist");
const geminiPreloadSource = fs.readFileSync(
  path.join(sourceRoot, "gemini-preload.js"),
  "utf8",
);
const listenerMarker = '\nipcRenderer.on("gemini:run-job"';
const listenerIndex = geminiPreloadSource.indexOf(listenerMarker);
if (listenerIndex < 0) {
  throw new Error("Gemini page runtime listener marker is missing");
}
const firstLineEnd = geminiPreloadSource.indexOf("\n") + 1;
const geminiRuntimeBody = geminiPreloadSource.slice(
  firstLineEnd,
  listenerIndex,
);
const geminiPageRuntime = `(() => {
  const native = globalThis.flowcutGeminiNative;
  if (!native) throw new Error("FlowCut Gemini native bridge is unavailable");
  const ipcRenderer = {
    invoke(channel, ...args) {
      if (channel === "gemini:upload-files-via-chooser") return native.uploadFiles(...args);
      if (channel === "gemini:replace-editor-text") return native.replaceEditorText(...args);
      if (channel === "gemini:send-key") return native.sendKey(...args);
      throw new Error("Unsupported FlowCut native action");
    },
    send(channel, payload) {
      if (channel === "gemini:job-diagnostic") return native.reportDiagnostic(payload);
      if (channel === "gemini:job-stage") return native.reportStage(payload);
      throw new Error("Unsupported FlowCut native event");
    }
  };
  ${geminiRuntimeBody}
  globalThis.__flowcutRunGeminiJob = async (job) => {
    try {
      const result = await executeGeminiJob(job);
      return {
        requestId: job.requestId,
        ok: true,
        prompt: result.prompt,
        analysis: result.analysis,
        rewrittenScript: result.rewrittenScript || "",
        extractionJson: result.extractionJson || "",
        storyboardJson: result.storyboardJson || "",
        rawGroupsJson: result.rawGroupsJson || "",
        optimizedGroupsJson: result.optimizedGroupsJson || ""
      };
    } catch (error) {
      return {
        requestId: job.requestId,
        ok: false,
        code: error?.code || "",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
  return true;
})()`;
const integrity = {
  runtime: Object.fromEntries(
    [
      "preload-ui.js",
      "gemini-preload.js",
      "site-runtime-host.cjs",
      "boot.html",
    ].map((name) => [
      name,
      sha256(path.join(outputRoot, name)),
    ]),
  ),
  site: Object.fromEntries(
    filesUnder(siteDistRoot).map((file) => [
      path.relative(siteDistRoot, file).replace(/\\/g, "/"),
      sha256(file),
    ]),
  ),
};

esbuild.buildSync({
  entryPoints: [path.join(sourceRoot, "main.js")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["electron", "electron-updater"],
  define: {
    "process.env.NODE_ENV": '"production"',
    __FLOWCUT_RUNTIME_INTEGRITY__: JSON.stringify(integrity),
    __FLOWCUT_GEMINI_PAGE_RUNTIME__: JSON.stringify(geminiPageRuntime),
  },
});

fs.writeFileSync(
  path.join(outputRoot, "bootstrap.cjs"),
  '"use strict";require("bytenode");require("./main.jsc");\n',
  "utf8",
);

void bytenode
  .compileFile({
    filename: bundlePath,
    output: bytecodePath,
    electronMain: true,
    electronPath: require("electron"),
    compileAsModule: true,
  })
  .then(() => {
    fs.rmSync(bundlePath, { force: true });
    const files = fs.readdirSync(outputRoot);
    if (!files.includes("main.jsc") || files.includes("main.bundle.cjs")) {
      throw new Error("FlowCut 字节码构建结果不完整");
    }
    console.log(`Protected desktop runtime built: ${outputRoot}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
