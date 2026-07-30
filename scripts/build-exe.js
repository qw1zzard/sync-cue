import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const bundle = join(dist, "server.cjs");
const blob = join(dist, "sync-cue.blob");
const executable = join(root, "SyncCue.exe");
const seaConfig = join(dist, "sea-config.json");
const dataDir = join(root, "SyncCueData");
const legacyDataDir = join(dist, "SyncCueData");

try {
  if (existsSync(legacyDataDir) && !existsSync(dataDir)) {
    cpSync(legacyDataDir, dataDir, { recursive: true });
  }
  rmSync(executable, { force: true });
  rmSync(dist, { recursive: true, force: true });
} catch (error) {
  if (error.code === "EPERM" || error.code === "EBUSY") {
    console.error("Cannot rebuild SyncCue.exe while it is running.");
    console.error("Close SyncCue.exe and run npm run build:exe again.");
    process.exit(1);
  }
  throw error;
}
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
    "app.js": join(root, "public", "app.js"),
    "playback-timing.js": join(root, "lib", "playback-timing.js")
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
rmSync(dist, { recursive: true, force: true });

console.log(executable);
