import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");

const outdir = path.join(process.cwd(), "dist");
if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

function copyReleaseFiles() {
  fs.copyFileSync(path.join(process.cwd(), "manifest.json"), path.join(outdir, "manifest.json"));
}

function copyForLocalPluginFolder() {
  fs.copyFileSync(path.join(outdir, "main.js"), path.join(process.cwd(), "main.js"));
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "dist/main.js",
  external: ["obsidian", "electron"],
  logLevel: "info"
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  copyReleaseFiles();
  copyForLocalPluginFolder();
  console.log("Watching for changes…");
} else {
  await esbuild.build(options);
  copyReleaseFiles();
  copyForLocalPluginFolder();
}
