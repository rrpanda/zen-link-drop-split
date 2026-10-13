const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { splitTab, findLeaf } = require("../link-drop-split.uc.js");

const nativeTest = (name, fn) => test(name, { skip: !process.env.ZEN_SPLITTER_SOURCE }, fn);

function nativeHarness() {
  // Execute the real class, including its private splitTabs bookkeeping.
  const source = readFileSync(process.env.ZEN_SPLITTER_SOURCE, "utf8")
    .replace(/^import .*;$/m, "class nsZenDOMOperatedFeature {}");
  const tabpanels = { classList: { add() {}, remove() {} } };
  const gBrowser = {
    tabpanels,
    selectedTab: null,
    pinTab(tab) { tab.pinned = true; },
    unpinTab(tab) { tab.pinned = false; },
    moveTabToExistingGroup(tab, group) { tab.group = group; },
    duplicateTab() { throw new Error("The mod should not cause duplicate tabs."); },
  };
  const context = {
    window: { gBrowser }, gBrowser,
    gZenGlanceManager: { getTabOrGlanceParent: tab => tab },
    gZenUIManager: { showToast() {} },
    CustomEvent: class {}, requestAnimationFrame: callback => callback(),
  };
  vm.runInNewContext(source, context, { filename: "upstream/ZenViewSplitter.mjs" });
  const splitter = context.window.gZenViewSplitter;
  // Replace UI/Firefox services only; tree creation, admission, insertion,
  // removal and percentage calculation all execute upstream implementations.
  splitter._getSplitViewGroup = tabs => tabs.find(tab => tab.group)?.group ?? { dispatchEvent() {} };
  splitter._removeNodeSplitters = () => {};
  splitter.getSplitters = (node, count) => Array.from({ length: count }, () => ({ style: {} }));
  splitter.maybeDisableOpeningTabOnSplitView = () => {};
  splitter.activateSplitView = group => {
    group.tabs.forEach(tab => { tab.splitView = true; });
    splitter.currentView = splitter._data.indexOf(group);
    splitter.applyGridLayout(group.layoutTree);
  };
  function tab(id, pinned = false) {
    const container = { style: {} };
    return { id, hidden: false, pinned, hasAttribute: () => false,
      linkedBrowser: { closest: () => container }, container };
  }
  return { splitter, tab, gBrowser };
}

function bounds(splitter, tab) {
  const position = findLeaf(splitter._data[0].layoutTree, tab).positionToRoot;
  return { left: position.left, top: position.top,
    width: 100 - position.left - position.right,
    height: 100 - position.top - position.bottom };
}

function close(actual, expected) {
  for (const key of Object.keys(expected)) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8,
      `${key}: expected ${expected[key]}, received ${actual[key]}`);
  }
}

nativeTest("native Zen first splits match all four drop directions", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const { splitter, tab, gBrowser } = nativeHarness();
    const a = tab("a"), b = tab("b"); gBrowser.selectedTab = a;
    const group = splitTab(splitter, a, b, side);
    assert.equal(group.tabs.length, 2);
    close(bounds(splitter, b), {
      left: side === "right" ? 50 : 0, top: side === "bottom" ? 50 : 0,
      width: ["left", "right"].includes(side) ? 50 : 100,
      height: ["top", "bottom"].includes(side) ? 50 : 100,
    });
  }
});

nativeTest("native Zen later drops split only the target pane, creating a four-pane layout", () => {
  const { splitter, tab, gBrowser } = nativeHarness();
  const a = tab("a"), b = tab("b"), c = tab("c"), d = tab("d");
  gBrowser.selectedTab = a;
  splitTab(splitter, a, b, "right");
  const originalA = bounds(splitter, a);
  splitTab(splitter, b, c, "bottom");
  close(bounds(splitter, a), originalA);
  close(bounds(splitter, b), { left: 50, top: 0, width: 50, height: 50 });
  close(bounds(splitter, c), { left: 50, top: 50, width: 50, height: 50 });
  const originalB = bounds(splitter, b), originalC = bounds(splitter, c);
  splitTab(splitter, a, d, "top");
  close(bounds(splitter, b), originalB); close(bounds(splitter, c), originalC);
  close(bounds(splitter, d), { left: 0, top: 0, width: 50, height: 50 });
  assert.equal(splitter._data[0].tabs.length, 4);
});

nativeTest("native Zen preserves custom resized siblings for same-axis and nested splits", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const { splitter, tab, gBrowser } = nativeHarness();
    const a = tab("a"), b = tab("b"), c = tab("c"); gBrowser.selectedTab = a;
    const group = splitTab(splitter, a, b, "right");
    findLeaf(group.layoutTree, a).sizeInParent = 30;
    findLeaf(group.layoutTree, b).sizeInParent = 70;
    splitter.applyGridLayout(group.layoutTree);
    const originalA = bounds(splitter, a);
    splitTab(splitter, b, c, side);
    close(bounds(splitter, a), originalA);
    const bBounds = bounds(splitter, b), cBounds = bounds(splitter, c);
    close({ area: bBounds.width * bBounds.height + cBounds.width * cBounds.height }, { area: 7000 });
    assert.equal(findLeaf(group.layoutTree, b).parent, findLeaf(group.layoutTree, c).parent);
  }
});

nativeTest("native Zen handles pinned splits without cloning the target tab", () => {
  const { splitter, tab, gBrowser } = nativeHarness();
  const a = tab("a", true), b = tab("b", true), c = tab("c", true);
  gBrowser.selectedTab = a;
  splitTab(splitter, a, b, "right"); splitTab(splitter, b, c, "bottom");
  assert.equal(splitter._data[0].tabs[0], a);
  assert.equal(splitter._data[0].tabs.length, 3);
});

nativeTest("native Zen relocation failure restores a layout that can safely close the new tab", () => {
  const { splitter, tab, gBrowser } = nativeHarness();
  const a = tab("a"), b = tab("b"), c = tab("c"); gBrowser.selectedTab = a;
  const group = splitTab(splitter, a, b, "right");
  splitter.splitIntoNode = () => { throw new Error("Simulated insertion failure"); };
  assert.throws(() => splitTab(splitter, b, c, "bottom"), /Simulated/);
  assert.ok(findLeaf(group.layoutTree, c));
  splitter.removeNode(findLeaf(group.layoutTree, c));
  splitter.applyGridLayout(group.layoutTree);
  close(bounds(splitter, a), { left: 0, top: 0, width: 50, height: 100 });
  close(bounds(splitter, b), { left: 50, top: 0, width: 50, height: 100 });
});
