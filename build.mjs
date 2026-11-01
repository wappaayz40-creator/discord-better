/* Bundles the Worker and copies the static client into the deploy
   directory that freebuff-sites-build/manifest.json points at. */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = "freebuff-sites-build";
const ASSETS = OUT + "/assets";

await rm(ASSETS, { recursive: true, force: true });
await mkdir(ASSETS, { recursive: true });

await build({
  entryPoints: ["worker.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import"],
  outfile: OUT + "/worker.js",
  legalComments: "none",
});

for (const path of ["index.html", "css", "js", "assets"]) {
  await cp(path, ASSETS + "/" + path, { recursive: true });
}

console.log("built", OUT);
