const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const workspaceRoot = path.resolve(__dirname, "..", "..");
const distRoot = path.join(workspaceRoot, "dist");
const serverRoot = path.join(distRoot, "server");

if (!fs.existsSync(path.join(serverRoot, "index.js"))) {
  throw new Error("FlowCut 网站构建产物不存在，无法执行发布加固");
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

for (const file of filesUnder(serverRoot).filter((item) => item.endsWith(".js"))) {
  const source = fs.readFileSync(file, "utf8");
  const result = esbuild.transformSync(source, {
    loader: "js",
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });
  fs.writeFileSync(file, result.code, "utf8");
}

const forbidden = filesUnder(distRoot).filter((file) =>
  /\.(?:ts|tsx|map)$/i.test(file),
);
if (forbidden.length) {
  throw new Error(`发布产物包含源码或映射文件：${forbidden.join(", ")}`);
}

console.log("Compiled FlowCut site artifacts hardened.");
