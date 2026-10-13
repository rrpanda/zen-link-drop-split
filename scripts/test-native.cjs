// Check the adapter against upstream Zen code, with browser UI services stubbed.
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

(async () => {
  const ref = process.env.ZEN_SPLITTER_REF || "bce6a23ea7082967bc27a92ae8613a4b04f3dae3";
  const sources = {
    ZEN_WORKSPACES_SOURCE: "src/zen/spaces/ZenSpaceManager.mjs",
    ZEN_TABBROWSER_PATCH: "src/browser/components/tabbrowser/Tabbrowser-sys-mjs.patch",
    ZEN_SPLITTER_SOURCE: "src/zen/split-view/ZenViewSplitter.mjs",
    ZEN_COMMON_ACTIONS_SOURCE: "src/zen/common/modules/ZenCommonUtils.mjs",
    ZEN_BACK_COMMANDS_PATCH: "src/browser/base/content/browser-commands-js.patch",
    ZEN_GESTURE_PATCH: "src/browser/base/content/browser-gestureSupport-js.patch",
  };
  const directory = await mkdtemp(join(tmpdir(), "zen-link-drop-native-"));
  try {
    const files = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([key, path]) => {
      const url = `https://raw.githubusercontent.com/zen-browser/desktop/${ref}/${path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Could not fetch ${path}: HTTP ${response.status}`);
      const file = join(directory, path.split("/").at(-1));
      await writeFile(file, await response.text());
      return [key, file];
    })));
    console.log(`Testing native Zen layout, workspace and Back APIs from ${ref}`);
    const result = spawnSync(process.execPath, ["--test", "tests/zen-native.test.cjs"], {
      stdio: "inherit", env: { ...process.env, ...files },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
