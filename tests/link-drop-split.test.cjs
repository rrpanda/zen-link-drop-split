const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chooseSide, previewRect, isWebURL, isLinkTransfer, linkDropEffect,
  LinkDropController } = require("../link-drop-split.uc.js");

const rect = { left: 100, top: 80, width: 1200, height: 800 };

test("first split uses middle left/right and full-width top/bottom zones", () => {
  for (const [x, y, side] of [
    [110, 480, "left"], [1290, 480, "right"],
    [700, 90, "top"], [700, 870, "bottom"],
    [110, 90, "top"], [1290, 870, "bottom"], [700, 480, null],
  ]) {
    assert.equal(chooseSide(rect, x, y, false), side);
  }
  assert.equal(chooseSide(rect, 99, 480, false), null);
  assert.equal(chooseSide({ ...rect, width: 0 }, 100, 80, false), null);
});

test("later drops divide the longer dimension regardless of the nearest edge", () => {
  assert.equal(chooseSide(rect, 1000, 81, true), "right");
  assert.equal(chooseSide(rect, 200, 879, true), "left");
  const tall = { ...rect, width: 500 };
  assert.equal(chooseSide(tall, 101, 700, true), "bottom");
  assert.equal(chooseSide(tall, 599, 200, true), "top");
  const square = { ...rect, width: 800 };
  assert.equal(chooseSide(square, 500, 90, true), "top");
  assert.equal(chooseSide(square, 500, 480, true), "right");
});

test("preview occupies exactly the intended half of the target pane", () => {
  assert.deepEqual(previewRect(rect, "right"), { left: 700, top: 80, width: 600, height: 800 });
  assert.deepEqual(previewRect(rect, "bottom"), { left: 100, top: 480, width: 1200, height: 400 });
});

test("only single web link drags are eligible", () => {
  assert.equal(isLinkTransfer({ types: ["text/x-moz-url", "text/plain"], mozItemCount: 1 }), true);
  for (const types of [["text/plain"], ["Files", "text/uri-list"],
    ["application/x-moz-tabbrowser-tab", "text/uri-list"],
    ["application/x-moz-file-promise", "text/x-moz-url"]]) {
    assert.equal(isLinkTransfer({ types, mozItemCount: 1 }), false);
  }
  assert.equal(isLinkTransfer({ types: ["text/uri-list"], mozItemCount: 2 }), false);
  assert.equal(isWebURL("https://example.com/path?q=a#b"), true);
  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/x",
    "about:config", "just text", "mailto:a@example.com"]) {
    assert.equal(isWebURL(url), false);
  }
});

test("drop cursor respects the source's allowed operations", () => {
  for (const allowed of ["all", "copy", "copyLink", "copyMove", "uninitialized"]) {
    assert.equal(linkDropEffect({ effectAllowed: allowed }), "copy");
  }
  assert.equal(linkDropEffect({ effectAllowed: "link" }), "link");
  assert.equal(linkDropEffect({ effectAllowed: "none" }), "none");
  assert.equal(linkDropEffect({ effectAllowed: "move" }), "none");
});

function element() {
  return {
    style: {}, hidden: false, children: [],
    setAttribute() {}, toggleAttribute() {},
    appendChild(child) { this.children.push(child); this.firstChild = this.children[0]; },
    remove() { this.removed = true; },
  };
}

function harness() {
  const calls = { added: [], removed: [], splits: [], errors: [], validated: [],
    prefAdds: [], prefRemoves: [], listeners: [], observerAdds: [], observerRemoves: [] };
  const sourceContext = {}; sourceContext.top = sourceContext;
  const attrs = new Map([["usercontextid", "3"]]);
  const browser = { browsingContext: sourceContext, getBoundingClientRect: () => rect };
  const targetTab = { linkedBrowser: browser, hidden: false, pinned: false,
    getAttribute: name => attrs.get(name) ?? "", hasAttribute: name => attrs.has(name) };
  const prefs = new Map();
  const links = [{ url: "https://example.com/new", name: "Example" }];
  const principal = { origin: "https://source.example" };
  const policy = {};
  const services = {
    prefs: {
      getBoolPref: (name, fallback) => prefs.has(name) ? prefs.get(name) : fallback,
      addObserver: (...args) => calls.prefAdds.push(args),
      removeObserver: (...args) => calls.prefRemoves.push(args),
    },
    obs: {
      addObserver: (...args) => calls.observerAdds.push(args),
      removeObserver: (...args) => calls.observerRemoves.push(args),
    },
    droppedLinkHandler: {
      queryLinks: () => links,
      dropLinks: (event, disallow) => { calls.validated.push(disallow); return links; },
      getTriggeringPrincipal: () => principal,
      getPolicyContainer: () => policy,
    },
  };
  const splitter = {
    _data: [], MAX_TABS: 4,
    splitTabs(tabs, gridType, index) {
      calls.splits.push({ tabs, gridType, index });
      const group = { tabs, layoutTree: { children: tabs.map(tab => ({ tab })) } };
      this._data.push(group); return group;
    },
    removeNode() {}, splitIntoNode() {}, activateSplitView() {},
  };
  const win = {
    gBrowserInit: { delayedStartupFinished: true },
    gBrowser: { selectedTab: targetTab, browsers: [browser],
      addTab(url, options) {
        calls.added.push({ url, options });
        this.selectedTab.owner = null;
        return { closing: false, owner: options.ownerTab ?? null,
          pinned: options.pinned, hasAttribute: () => false };
      },
      removeTab: tab => calls.removed.push(tab),
    },
    gZenViewSplitter: splitter,
    document: { createElementNS: () => element(), documentElement: element() },
    console: { error: (...args) => calls.errors.push(args) },
    addEventListener: (...args) => calls.listeners.push(args),
    removeEventListener: (...args) => {
      calls.listeners = calls.listeners.filter(entry => !entry.every((value, i) => value === args[i]));
    },
  };
  browser.localName = "browser"; browser.ownerGlobal = win;
  const controller = new LinkDropController(win, services);
  const event = {
    target: browser, originalTarget: browser, composedPath() { return [this.target, win]; },
    isTrusted: true, clientX: 1290, clientY: 480, altKey: false,
    dataTransfer: { types: ["text/x-moz-url", "text/plain"], mozItemCount: 1,
      effectAllowed: "copy", sourceTopWindowContext: { browsingContext: sourceContext } },
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  return { controller, event, calls, win, services, prefs, links, targetTab, attrs, principal, policy };
}

test("same-window drops use the source principal and target container, then focus the new tab", () => {
  const h = harness();
  h.controller.onDragOver(h.event);
  assert.equal(h.event.dataTransfer.dropEffect, "copy");
  assert.equal(h.controller.preview.style.left, "700px");
  assert.equal(h.controller.preview.hidden, false);
  h.controller.onDrop(h.event);
  assert.equal(h.event.prevented, true);
  assert.equal(h.event.stopped, true);
  assert.equal(h.controller.preview.hidden, true);
  assert.deepEqual(h.calls.validated, [true]);
  assert.equal(h.calls.added.length, 1);
  assert.equal(h.calls.added[0].options.triggeringPrincipal, h.principal);
  assert.equal(h.calls.added[0].options.policyContainer, h.policy);
  assert.equal(h.calls.added[0].options.userContextId, 3);
  assert.equal(h.calls.added[0].options.skipRoute, true);
  assert.equal(h.win.gBrowser.selectedTab.owner, h.targetTab);
  assert.equal(h.calls.splits[0].gridType, "vsep");
  assert.equal(h.calls.splits[0].tabs[0], h.targetTab);
  assert.equal(h.win.gBrowser.selectedTab, h.calls.splits[0].tabs[1]);
});

test("top and left drops insert the new tab before the target", () => {
  for (const [x, y, type] of [[200, 480, "vsep"], [700, 90, "hsep"]]) {
    const h = harness(); h.event.clientX = x; h.event.clientY = y;
    h.controller.onDrop(h.event);
    assert.equal(h.calls.splits[0].tabs[1], h.targetTab);
    assert.equal(h.calls.splits[0].gridType, type);
    assert.equal(h.calls.splits[0].index, 0);
  }
});

test("pinned target creates a pinned new tab to avoid Zen duplicating the target", () => {
  const h = harness(); h.targetTab.pinned = true;
  h.controller.onDrop(h.event);
  assert.equal(h.calls.added[0].options.pinned, true);
});

test("dropping into another pane targets that pane rather than the selected tab", () => {
  const h = harness();
  const other = { ...h.targetTab, linkedBrowser: {
    getBoundingClientRect: () => ({ left: 700, top: 80, width: 600, height: 800 }),
  } };
  h.targetTab.linkedBrowser.getBoundingClientRect = () => ({ left: 100, top: 80, width: 600, height: 800 });
  h.win.gZenViewSplitter._data.push({ tabs: [h.targetTab, other] });
  h.event.target = h.event.originalTarget = other.linkedBrowser;
  const plan = h.controller.getDropPlan(h.event);
  assert.equal(plan.tab, other);
  assert.equal(plan.side, "bottom");
  h.controller.onDrop(h.event);
  assert.equal(h.calls.errors.length, 0);
  assert.equal(h.calls.added[0].options.ownerTab, other);
  assert.equal(h.win.gBrowser.selectedTab.owner, other);
});

test("full split group blocks the drop without opening or replacing a tab", () => {
  const h = harness();
  h.win.gZenViewSplitter._data.push({ tabs: [h.targetTab, {}, {}, {}] });
  h.controller.onDragOver(h.event);
  assert.equal(h.event.dataTransfer.dropEffect, "none");
  assert.equal(h.controller.preview.firstChild.textContent, "Split view is full");
  h.controller.onDrop(h.event);
  assert.equal(h.event.prevented, true);
  assert.equal(h.calls.added.length, 0);
});

test("unrelated drags and bypass gestures leave the native handlers available", () => {
  const changes = [
    h => { h.event.altKey = true; },
    h => { h.event.isTrusted = false; },
    h => { h.prefs.set("zen.link-drop-split.enabled", false); },
    h => { h.event.dataTransfer.sourceTopWindowContext = null; },
    h => { h.event.dataTransfer.sourceTopWindowContext.browsingContext = { top: {} }; },
    h => { h.event.dataTransfer.types = ["text/plain"]; },
    h => { h.event.dataTransfer.types.push("application/x-moz-tabbrowser-tab"); },
    h => { h.links[0].url = "javascript:alert(1)"; },
    h => { h.links.push({ url: "https://example.com/second" }); },
    h => { h.event.clientX = 700; h.event.clientY = 480; },
    h => { h.event.clientX = 10; },
    h => { h.win.gZenViewSplitter.splitIntoNode = null; },
    h => { h.attrs.set("zen-essential", "true"); },
  ];
  for (const change of changes) {
    const h = harness(); change(h);
    h.controller.onDragOver(h.event); h.controller.onDrop(h.event);
    assert.equal(h.calls.added.length, 0);
    assert.equal(h.event.prevented, undefined);
  }
});

test("source node fallback accepts browser-chrome links from this window only", () => {
  const h = harness(); h.event.dataTransfer.sourceTopWindowContext = null;
  h.event.dataTransfer.mozSourceNode = { ownerGlobal: h.win };
  assert.ok(h.controller.getDropPlan(h.event));
  h.event.dataTransfer.mozSourceNode.ownerGlobal = {};
  assert.equal(h.controller.getDropPlan(h.event), null);
});

test("URL validation failure is consumed before tab creation", () => {
  const h = harness();
  h.services.droppedLinkHandler.dropLinks = () => { throw new Error("Denied URL"); };
  h.controller.onDrop(h.event);
  assert.equal(h.event.prevented, true);
  assert.equal(h.calls.added.length, 0);
  assert.equal(h.calls.errors.length, 1);
});

test("split rejection removes only the created tab and restores focus", () => {
  const h = harness(); h.win.gZenViewSplitter.splitTabs = () => undefined;
  h.controller.onDrop(h.event);
  assert.equal(h.calls.added.length, 1);
  assert.equal(h.calls.removed.length, 1);
  assert.equal(h.win.gBrowser.selectedTab, h.targetTab);
});

test("preview preference hides visual feedback while retaining split behavior", () => {
  const h = harness(); h.prefs.set("zen.link-drop-split.preview", false);
  h.controller.onDragOver(h.event);
  assert.equal(h.controller.preview, null);
  assert.equal(h.event.prevented, true);
  h.controller.onDrop(h.event);
  assert.equal(h.calls.added.length, 1);
});

test("disabling the mod removes listeners, preference observers and preview", () => {
  const h = harness(); h.win.ZenLinkDropSplit = h.controller;
  h.controller.start(); h.controller.onDragOver(h.event);
  const preview = h.controller.preview;
  assert.ok(h.calls.listeners.length > 0);
  h.controller.destroy(); h.controller.destroy();
  assert.equal(h.calls.listeners.length, 0);
  assert.equal(h.calls.prefAdds.length, 1);
  assert.equal(h.calls.prefRemoves.length, 1);
  assert.equal(preview.removed, true);
  assert.equal(h.win.ZenLinkDropSplit, undefined);
});

test("startup deferral attaches only to this window and can be cancelled", () => {
  const h = harness(); h.win.gBrowserInit.delayedStartupFinished = false;
  h.controller.start();
  const observer = h.calls.observerAdds[0][0];
  observer({}); assert.equal(h.calls.prefAdds.length, 0);
  observer(h.win); assert.equal(h.calls.prefAdds.length, 1);
  assert.equal(h.calls.observerRemoves.length, 1);
  h.controller.destroy();
  const early = harness(); early.win.gBrowserInit.delayedStartupFinished = false;
  early.controller.start(); early.controller.destroy();
  assert.equal(early.calls.prefRemoves.length, 0);
  assert.equal(early.calls.observerRemoves.length, 1);
});

// Mirror Firefox's URI-list and moz-url extraction, rather than pre-cleaning
// the fixture: native URI-list parsing emits empty entries for blank lines.
function usePayload(h, type, payload) {
  h.event.dataTransfer.types = [type, "text/plain"];
  h.event.dataTransfer.getData = requested => requested === type ? payload : "";
  h.event.dataTransfer.mozTypesAt = () => ({ contains: requested => requested === type });
  h.event.dataTransfer.mozGetDataAt = requested => h.event.dataTransfer.getData(requested);
  h.services.droppedLinkHandler.queryLinks = transfer => {
    const lines = transfer.mozGetDataAt(type, 0).split("\n");
    return type === "text/uri-list" ? lines.filter(line => !line.startsWith("#"))
      .map(line => ({ url: line.trim(), name: line.trim(), type })) :
      lines.filter((_, index) => index % 2 === 0).map(url => ({ url, type }));
  };
  h.services.droppedLinkHandler.dropLinks = (event, disallow) => {
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.equal(disallow, true);
    const links = h.services.droppedLinkHandler.queryLinks(event.dataTransfer);
    for (const link of links) {
      if (link.url.trim()) h.calls.validated.push(link.url.trim());
    }
    return links;
  };
}

test("native URI-list blank lines, CRLF and comments retain a single real URL", () => {
  for (const payload of ["https://example.com/new\r\n",
    "\r\n# comment\r\nhttps://example.com/new\r\n \t\r\n",
    "https://example.com/new\n\n", "  https://example.com/new  \r\n"]) {
    const h = harness(); usePayload(h, "text/uri-list", payload);
    h.controller.onDragOver(h.event);
    assert.equal(h.event.prevented, true);
    h.controller.onDrop(h.event);
    assert.equal(h.calls.added.length, 1);
    assert.deepEqual(h.calls.validated, ["https://example.com/new"]);
  }
  const h = harness(); usePayload(h, "text/x-moz-url", "https://example.com/new\nExample title\n");
  h.controller.onDrop(h.event);
  assert.equal(h.calls.added.length, 1);
});

test("URI-list multiple real URLs, invalid schemes and blank-only payloads remain ordinary drops", () => {
  for (const payload of ["https://example.com/one\r\nhttps://example.com/two\r\n",
    "https://example.com/one\n# comment\njavascript:alert(1)\n",
    "javascript:alert(1)\r\n", "file:///tmp/x\r\n", "not a URL\r\n", "# comment\n \t\r\n"]) {
    const h = harness(); usePayload(h, "text/uri-list", payload);
    h.controller.onDragOver(h.event); h.controller.onDrop(h.event);
    assert.equal(h.event.prevented, undefined);
    assert.equal(h.calls.added.length, 0);
  }
});

test("blank filtering runs after native validation and does not hide security failures", () => {
  const h = harness(); usePayload(h, "text/uri-list", "https://example.com/new\r\n");
  h.services.droppedLinkHandler.dropLinks = event => {
    assert.equal(event.prevented, true);
    throw new Error("Native principal security rejection");
  };
  h.controller.onDrop(h.event);
  assert.equal(h.calls.added.length, 0);
  assert.equal(h.calls.errors.length, 1);
});

test("real content and iframe targets match the exact candidate pane", () => {
  for (const iframe of [false, true]) {
    const h = harness();
    const top = h.targetTab.linkedBrowser.browsingContext;
    const ownerGlobal = { browsingContext: iframe ? { top } : top };
    const target = { localName: "input", ownerGlobal };
    h.event.target = h.event.originalTarget = target;
    h.controller.onDrop(h.event);
    assert.equal(h.calls.added.length, 1);
  }
  const h = harness();
  h.event.target = h.event.originalTarget = { localName: "a", ownerGlobal: { browsingContext: { top: {} } } };
  assert.equal(h.controller.getDropPlan(h.event), null);
});

test("chrome inputs, overlays, retargeted chrome descendants and absent targets are ignored", () => {
  for (const kind of ["input", "panel", "toolbarbutton", "missing", "original", "path", "other-browser"]) {
    const h = harness();
    const chrome = { localName: kind, ownerGlobal: h.win };
    if (kind === "original") h.event.originalTarget = chrome;
    else if (kind === "path") h.event.composedPath = () => [chrome, h.event.target, h.win];
    else if (kind === "other-browser") h.event.target = h.event.originalTarget = { localName: "browser", ownerGlobal: h.win };
    else h.event.target = h.event.originalTarget = kind === "missing" ? undefined : chrome;
    h.controller.onDragOver(h.event); h.controller.onDrop(h.event);
    assert.equal(h.event.prevented, undefined, kind);
    assert.equal(h.calls.added.length, 0, kind);
    assert.equal(h.controller.preview, null, kind);
  }
});


test("workspace option is supplied only when the target has an explicit workspace", () => {
  for (const workspace of [undefined, "", "workspace-a"]) {
    const h = harness();
    if (workspace !== undefined) h.attrs.set("zen-workspace-id", workspace);
    h.controller.onDrop(h.event);
    const options = h.calls.added[0].options;
    assert.equal(Object.hasOwn(options, "zenWorkspaceId"), Boolean(workspace));
    if (workspace) assert.equal(options.zenWorkspaceId, workspace);
  }
});

test("failed tab creation and splitting restore the selected pane's owner", () => {
  for (const failure of ["split", "throw", "null"]) {
    const h = harness();
    const owner = { isConnected: true };
    h.targetTab.owner = owner;
    if (failure === "split") h.win.gZenViewSplitter.splitTabs = () => undefined;
    else h.win.gBrowser.addTab = function() {
      this.selectedTab.owner = null;
      if (failure === "throw") throw new Error("creation failed after owner clearing");
      return null;
    };
    h.controller.onDrop(h.event);
    assert.equal(h.targetTab.owner, owner, failure);
    assert.equal(h.win.gBrowser.selectedTab, h.targetTab, failure);
    assert.equal(h.calls.removed.length, failure === "split" ? 1 : 0);
  }
});

test("rollback does not revive a closing or detached pane or owner", () => {
  for (const subject of ["pane", "owner"]) {
    for (const state of [{ closing: true }, { isConnected: false }]) {
      const h = harness();
      const owner = { isConnected: true };
      h.targetTab.owner = owner;
      h.win.gBrowser.addTab = function() {
        this.selectedTab.owner = null;
        Object.assign(subject === "pane" ? h.targetTab : owner, state);
        return null;
      };
      h.controller.onDrop(h.event);
      assert.equal(h.targetTab.owner, null);
    }
  }
});

test("successful drops retain native clearing of the previous pane's owner", () => {
  const h = harness();
  h.targetTab.owner = { isConnected: true };
  h.controller.onDrop(h.event);
  assert.equal(h.targetTab.owner, null);
  assert.equal(h.win.gBrowser.selectedTab.owner, h.targetTab);
  assert.equal(h.calls.errors.length, 0);
});
