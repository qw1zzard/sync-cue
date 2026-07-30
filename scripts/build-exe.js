import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const bundle = join(dist, "server.cjs");
const blob = join(dist, "sync-cue.blob");
const executable = join(dist, "SyncCue.exe");
const seaConfig = join(dist, "sea-config.json");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
  entryPoints: [join(root, "server.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: { "import.meta.dirname": "__dirname" }
});

writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets: {
    "index.html": join(root, "public", "index.html"),
    "styles.css": join(root, "public", "styles.css"),
    "app.js": join(root, "public", "app.js")
  }
}));

execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
copyFileSync(process.execPath, executable);
execFileSync(process.execPath, [
  join(root, "node_modules", "postject", "dist", "cli.js"),
  executable,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
], { stdio: "inherit" });

rmSync(bundle);
rmSync(blob);
rmSync(seaConfig);

console.log(executable);
