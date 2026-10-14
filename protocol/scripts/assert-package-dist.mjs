import fs from "node:fs";
import path from "node:path";

if (process.env.npm_command === "publish") {
  throw new Error("Publish approved release artifact tarballs with publish-sdk-release.mjs; directory publication is disabled.");
}
const root = fs.realpathSync(process.cwd());
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const requiredFiles = new Set(["dist/index.js", "dist/index.d.ts"]);
function exports(value) {
  if (typeof value === "string") requiredFiles.add(value.replace(/^\.\//, ""));
  else if (value && typeof value === "object") for (const child of Object.values(value)) exports(child);
}
exports(manifest.exports);
const missing = [...requiredFiles].filter(file => {
  if (!file.startsWith("dist/") || file.includes("..") || file.includes("\\")) throw new Error("public export must name a dist file");
  const target = path.join(root, file);
  return !fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target;
});

if (missing.length > 0) {
  console.error(`package build output is missing: ${missing.join(", ")}. Run npm run build before packing or publishing.`);
  process.exit(1);
}
