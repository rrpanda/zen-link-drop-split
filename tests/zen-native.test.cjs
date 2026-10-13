const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { splitTab, findLeaf, LinkDropController } = require("../link-drop-split.uc.js");

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
    return { id, hidden: false, pinned, hasAttribute: () => false, getAttribute: () => "",
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

function nativeBackHarness(gBrowser) {
  const prefs = new Map();
  const context = {
    window: {}, gBrowser,
    Services: { prefs: { getBoolPref: (name, fallback) => prefs.get(name) ?? fallback } },
    BrowserUtils: { whereToOpenLink: () => "current" },
  };
  const common = readFileSync(process.env.ZEN_COMMON_ACTIONS_SOURCE, "utf8")
    .replace(/^export /gm, "");
  vm.runInNewContext(common, context, { filename: "upstream/ZenCommonUtils.mjs" });
  context.gZenCommonActions = context.window.gZenCommonActions;

  // Execute the actual current-tab branch from Zen's patched Back command.
  // The diff context ends before the closing braces for the if and the method.
  const commandPatch = readFileSync(process.env.ZEN_BACK_COMMANDS_PATCH, "utf8");
  const hunk = commandPatch.split(/^@@.*\n/m).find(part => part.includes("gBrowser.removeTab(gBrowser.selectedTab"));
  assert.ok(hunk, "Zen's native Back command hunk must exist");
  const body = hunk.split("\n")
    .filter(line => line.startsWith(" ") || line.startsWith("+"))
    .map(line => line.slice(1)).join("\n");
  const back = vm.runInNewContext(`(function(aEvent) { ${body}\n} })`, context);

  const gesturePatch = readFileSync(process.env.ZEN_GESTURE_PATCH, "utf8");
  const returnLine = gesturePatch.match(/^\+\s*(return gBrowser.webNavigation.canGoBack.*);$/m)?.[1];
  assert.ok(returnLine, "Zen's native swipe eligibility expression must exist");
  const canSwipeBack = vm.runInNewContext(`(function() { ${returnLine}; })`, context);
  return { prefs, back, canSwipeBack, actions: context.gZenCommonActions };
}

nativeTest("dropped split tabs support native Back-to-close while preserving history and preferences", () => {
  const { splitter, tab, gBrowser } = nativeHarness();
  const a = tab("a"), b = tab("b"); gBrowser.selectedTab = a;
  splitTab(splitter, a, b, "right");
  // Drop into an unfocused pane; the owner must be that pane, not the focused one.
  gBrowser.selectedTab = b;
  const sourceContext = {}; sourceContext.top = sourceContext;
  a.linkedBrowser.browsingContext = sourceContext;
  a.linkedBrowser.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 });
  b.linkedBrowser.getBoundingClientRect = () => ({ left: 600, top: 0, width: 600, height: 800 });
  gBrowser.browsers = [a.linkedBrowser, b.linkedBrowser];
  gBrowser.webNavigation = { canGoBack: false };
  let newTab, removed = [], navigated = 0;
  gBrowser.addTab = (url, options) => {
    gBrowser.selectedTab.owner = null;
    newTab = tab("new", options.pinned);
    newTab.owner = options.ownerTab ?? null;
    return newTab;
  };
  gBrowser.removeTab = value => { removed.push(value); };
  gBrowser.goBack = () => { navigated++; };
  const native = nativeBackHarness(gBrowser);
  const services = {
    prefs: { getBoolPref: (name, fallback) => fallback },
    droppedLinkHandler: {
      queryLinks: () => [{ url: "https://example.com" }],
      dropLinks: () => [{ url: "https://example.com" }],
      getTriggeringPrincipal: () => ({}),
    },
  };
  const controller = new LinkDropController({ gBrowser, gZenViewSplitter: splitter, console }, services);
  controller.onDrop({
    target: a.linkedBrowser, originalTarget: a.linkedBrowser,
    composedPath() { return [this.target]; },
    isTrusted: true, clientX: 300, clientY: 600,
    dataTransfer: { types: ["text/x-moz-url"], mozItemCount: 1,
      effectAllowed: "copy", sourceTopWindowContext: { browsingContext: sourceContext } },
    preventDefault() {}, stopImmediatePropagation() {},
  });
  assert.equal(gBrowser.selectedTab, newTab);
  assert.equal(newTab.owner, a, "owner persists through native split admission and relocation");
  assert.equal(native.actions.shouldCloseTabOnBack(), true);
  assert.equal(native.canSwipeBack(), true);
  native.back({});
  assert.deepEqual(removed, [newTab]);

  removed = []; gBrowser.webNavigation.canGoBack = true;
  native.back({});
  assert.deepEqual(removed, []);
  assert.equal(navigated, 1, "existing history is navigated instead of closing the split tab");

  gBrowser.webNavigation.canGoBack = false;
  native.prefs.set("zen.tabs.close-on-back-with-no-history", false);
  assert.equal(native.actions.shouldCloseTabOnBack(), false);
  assert.equal(native.canSwipeBack(), false);
  native.back({}); assert.deepEqual(removed, []);
  gBrowser.webNavigation.canGoBack = true;
  assert.equal(native.canSwipeBack(), true, "disabling close-on-back does not disable history swipes");
  gBrowser.webNavigation.canGoBack = false;

  native.prefs.set("zen.tabs.close-on-back-with-no-history", true);
  newTab.pinned = true;
  assert.equal(native.actions.shouldCloseTabOnBack(), false);
  assert.equal(native.canSwipeBack(), false);
  native.back({}); assert.deepEqual(removed, []);
});

function nativeDropHarness() {
  const h = nativeHarness();
  const target = h.tab("target");
  const attrs = new Map([["usercontextid", "3"], ["zen-workspace-id", "a"]]);
  target.getAttribute = name => attrs.get(name) ?? "";
  target.hasAttribute = name => attrs.has(name);
  const sourceContext = {}; sourceContext.top = sourceContext;
  target.linkedBrowser.browsingContext = sourceContext;
  target.linkedBrowser.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  h.gBrowser.selectedTab = target;
  h.gBrowser.browsers = [target.linkedBrowser];
  const errors = [];
  const controller = new LinkDropController({ gBrowser: h.gBrowser,
    gZenViewSplitter: h.splitter, console: { error: (...args) => errors.push(args) } }, {
    prefs: { getBoolPref: (name, fallback) => fallback },
    droppedLinkHandler: {
      queryLinks: () => [{ url: "https://example.com" }],
      dropLinks: () => [{ url: "https://example.com" }],
      getTriggeringPrincipal: () => ({}),
    },
  });
  const event = {
    target: target.linkedBrowser, originalTarget: target.linkedBrowser,
    composedPath() { return [this.target]; }, isTrusted: true, clientX: 790, clientY: 300,
    dataTransfer: { types: ["text/x-moz-url"], mozItemCount: 1,
      effectAllowed: "copy", sourceTopWindowContext: { browsingContext: sourceContext } },
    preventDefault() {}, stopImmediatePropagation() {},
  };
  return { ...h, target, attrs, controller, event, errors };
}

function patchedTabCreationParts() {
  const patch = readFileSync(process.env.ZEN_TABBROWSER_PATCH, "utf8");
  const lines = patch.split("\n").filter(line => line.startsWith(" ") ||
    (line.startsWith("+") && !line.startsWith("+++"))).map(line => line.slice(1)).join("\n");
  const clearOwner = lines.match(/    if \(this.selectedTab.owner\) \{\n      this.selectedTab.owner = null;\n    \}/)?.[0];
  const workspace = lines.match(/      if \(zenWorkspaceId\) \{[\s\S]*?\n      \} else if \(zenForcedWorkspaceId !== undefined\) \{[\s\S]*?\n      \}/)?.[0];
  assert.ok(clearOwner, "native addTab ownership clearing must exist");
  assert.ok(workspace, "native addTab explicit/forced workspace assignment must exist");
  return { clearOwner, workspace };
}

nativeTest("moved container drops keep the target workspace through native workspace forcing", async () => {
  const source = readFileSync(process.env.ZEN_WORKSPACES_SOURCE, "utf8");
  const contextMethod = source.slice(source.indexOf("  getContextIdIfNeeded("), source.indexOf("\n  getTabsToExclude("));
  const insertedMethod = source.slice(source.indexOf("  async onTabBrowserInserted("), source.indexOf("\n  #changeToEmptyTab("));
  assert.ok(contextMethod && insertedMethod, "native workspace methods must exist");
  const { workspace } = patchedTabCreationParts();
  for (const enabled of [true, false]) {
    const h = nativeDropHarness();
    const scheduled = [], changes = [];
    const workspaces = vm.runInNewContext(`({ ${contextMethod}, ${insertedMethod} })`, {
      gZenGlanceManager: { getTabOrGlanceParent: tab => tab },
      setTimeout: callback => scheduled.push(callback),
    });
    Object.assign(workspaces, {
      workspaceEnabled: enabled, shouldForceContainerTabsToWorkspace: true,
      _workspaceCache: [{ uuid: "a", containerTabId: 0 }, { uuid: "b", containerTabId: 3 }],
      getActiveWorkspaceFromCache() { return this._workspaceCache[0]; },
      lastSelectedWorkspaceTabs: {}, moveTabToWorkspace: () => true,
      getWorkspaceFromId(id) { return this._workspaceCache.find(value => value.uuid === id); },
      changeWorkspace(value) { changes.push(value.uuid); },
    });
    const assignWorkspace = vm.runInNewContext(`(function(t, zenWorkspaceId, zenForcedWorkspaceId) { ${workspace} })`);
    let newTab;
    h.gBrowser.addTab = (url, options) => {
      const [container, , forced] = workspaces.getContextIdIfNeeded(options.userContextId, undefined, options.triggeringPrincipal);
      assert.equal(container, 3);
      assert.equal(forced, enabled ? "b" : undefined, "container forcing still runs despite skipRoute");
      newTab = h.tab("new"); newTab.owner = options.ownerTab;
      const attributes = new Map();
      newTab.setAttribute = (name, value) => attributes.set(name, value);
      newTab.getAttribute = name => attributes.get(name) ?? "";
      newTab.hasAttribute = name => attributes.has(name);
      newTab.removeAttribute = name => attributes.delete(name);
      assignWorkspace(newTab, options.zenWorkspaceId, forced);
      return newTab;
    };
    h.controller.onDrop(h.event);
    assert.equal(h.errors.length, 0);
    assert.equal(newTab.getAttribute("zen-workspace-id"), "a");
    await workspaces.onTabBrowserInserted({ originalTarget: newTab });
    scheduled.forEach(callback => callback());
    assert.deepEqual(changes, enabled ? ["a"] : [], "no switch to the container's assigned workspace b");
  }
});

nativeTest("rollback preserves native Back eligibility after addTab clears ownership", () => {
  const { clearOwner } = patchedTabCreationParts();
  const clear = vm.runInNewContext(`(function() { ${clearOwner} })`);
  for (const failure of ["split", "throw", "null", "success"]) {
    const h = nativeDropHarness();
    const previousOwner = h.tab("previous-owner"); h.target.owner = previousOwner;
    h.gBrowser.webNavigation = { canGoBack: false };
    const native = nativeBackHarness(h.gBrowser);
    assert.equal(native.actions.shouldCloseTabOnBack(), true);
    let newTab;
    h.gBrowser.addTab = function(url, options) {
      clear.call(this);
      assert.equal(native.actions.shouldCloseTabOnBack(), false, "native addTab removes Back eligibility");
      if (failure === "throw") throw new Error("native addTab failure");
      if (failure === "null") return null;
      newTab = h.tab("new"); newTab.owner = options.ownerTab;
      return newTab;
    };
    h.gBrowser.removeTab = tab => { tab.closing = true; };
    if (failure === "split") h.splitter.splitTabs = () => undefined;
    h.controller.onDrop(h.event);
    if (failure === "success") {
      assert.equal(h.target.owner, null, "successful additions preserve native clearing");
      assert.equal(h.gBrowser.selectedTab, newTab);
    } else {
      assert.equal(h.target.owner, previousOwner);
      assert.equal(h.gBrowser.selectedTab, h.target);
      assert.equal(h.errors.length, 1);
      if (newTab) assert.equal(newTab.closing, true);
    }
    assert.equal(native.actions.shouldCloseTabOnBack(), true);
    assert.equal(native.canSwipeBack(), true);
  }
});
