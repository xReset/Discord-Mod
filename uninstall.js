/* DiscordMod uninstaller — restores the original app.asar. Discord must be fully quit. */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function fail(msg) {
  console.error("\n[uninstall] ERROR: " + msg + "\n");
  process.exit(1);
}

function assertDiscordQuit() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Discord.exe" /NH', { encoding: "utf8" });
    if (/Discord\.exe/i.test(out)) {
      fail("Discord is running — fully quit (tray icon → Quit), then re-run node uninstall.js");
    }
  } catch (e) {
    // If tasklist itself fails, proceed; locked-file errors will still surface later.
  }
}

function discordResources() {
  const base = path.join(process.env.LOCALAPPDATA || "", "Discord");
  if (!fs.existsSync(base)) fail("Discord Stable not found at " + base);
  const appDirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith("app-"))
    .map((d) => path.join(base, d))
    .filter((d) => fs.existsSync(path.join(d, "resources")))
    .sort();
  if (!appDirs.length) fail("no app-<version> folder found");
  return path.join(appDirs[appDirs.length - 1], "resources");
}

assertDiscordQuit();

const resources = discordResources();
const appAsar = path.join(resources, "app.asar");
const backup = path.join(resources, "_app.asar");

if (!fs.existsSync(backup)) fail("no _app.asar backup found — nothing to restore");

if (fs.existsSync(appAsar)) fs.rmSync(appAsar, { force: true });
fs.renameSync(backup, appAsar);

console.log("[uninstall] restored original app.asar ✓  Restart Discord.");
