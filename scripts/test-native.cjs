// Check the adapter against upstream Zen code, with browser UI services stubbed.
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

(async () => {
  const ref = process.env.ZEN_SPLITTER_REF || "bce6a23ea7082967bc27a92ae8613a4b04f3dae3";
  const url = `https://raw.githubusercontent.com/zen-browser/desktop/${ref}/src/zen/split-view/ZenViewSplitter.mjs`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not fetch Zen source: HTTP ${response.status}`);
  const directory = await mkdtemp(join(tmpdir(), "zen-link-drop-native-"));
  try {
    const file = join(directory, "ZenViewSplitter.mjs");
    await writeFile(file, await response.text());
    console.log(`Testing native Zen layout APIs from ${ref}`);
    const result = spawnSync(process.execPath, ["--test", "tests/zen-native.test.cjs"], {
      stdio: "inherit", env: { ...process.env, ZEN_SPLITTER_SOURCE: file },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
