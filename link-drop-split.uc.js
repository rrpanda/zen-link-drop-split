// ==UserScript==
// @name           Link Drop Split
// @description    Open same-window dragged links in pane-aware Zen split tabs.
// @version        0.1.0
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

/* global Services */
(() => {
  "use strict";

  const WINDOW_KEY = "ZenLinkDropSplit";
  const PREF_PREFIX = "zen.link-drop-split.";
  const LINK_TYPES = ["text/x-moz-url", "text/uri-list"];
  const IGNORED_TYPES = [
    "application/x-moz-tabbrowser-tab",
    "application/x-moz-file",
    "application/x-moz-file-promise",
    "application/x-moz-nativeimage",
    "Files",
  ];

  function containsPoint(rect, x, y) {
    return rect.width > 0 && rect.height > 0 &&
      x >= rect.left && x < rect.left + rect.width &&
      y >= rect.top && y < rect.top + rect.height;
  }

  // Top/bottom quarters span the pane. Left/right quarters use its middle half.
  // The center stays available for ordinary page drops until a split exists.
  function chooseSide(rect, x, y, alreadySplit) {
    if (!containsPoint(rect, x, y)) {
      return null;
    }
    const relativeX = (x - rect.left) / rect.width;
    const relativeY = (y - rect.top) / rect.height;
    if (alreadySplit) {
      // A square pane uses the first-split zones to break the tie.
      if (rect.width > rect.height) {
        return relativeX < 0.5 ? "left" : "right";
      }
      if (rect.height > rect.width) {
        return relativeY < 0.5 ? "top" : "bottom";
      }
    }
    if (relativeY <= 0.25) {
      return "top";
    }
    if (relativeY >= 0.75) {
      return "bottom";
    }
    if (relativeX <= 0.25) {
      return "left";
    }
    if (relativeX >= 0.75) {
      return "right";
    }
    return alreadySplit ? (relativeX < 0.5 ? "left" : "right") : null;
  }

  function previewRect(rect, side) {
    const result = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (side === "left" || side === "right") {
      result.width /= 2;
      if (side === "right") {
        result.left += result.width;
      }
    } else {
      result.height /= 2;
      if (side === "bottom") {
        result.top += result.height;
      }
    }
    return result;
  }

  function isWebURL(value) {
    try {
      return ["https:", "http:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }

  function isLinkTransfer(transfer) {
    if (!transfer || transfer.mozItemCount > 1) {
      return false;
    }
    const types = Array.from(transfer.types);
    return LINK_TYPES.some(type => types.includes(type)) &&
      !IGNORED_TYPES.some(type => types.includes(type));
  }

  function linkDropEffect(transfer) {
    const allowed = transfer.effectAllowed;
    if (["link", "linkMove"].includes(allowed)) {
      return "link";
    }
    if ([undefined, "uninitialized", "all", "copy", "copyLink", "copyMove"].includes(allowed)) {
      return "copy";
    }
    return "none";
  }

  function findLeaf(node, tab) {
    if (!node) {
      return null;
    }
    if (node.tab === tab) {
      return node;
    }
    for (const child of node.children ?? []) {
      const result = findLeaf(child, tab);
      if (result) {
        return result;
      }
    }
    return null;
  }

  function findGroup(splitter, tab) {
    return splitter._data.find(group => group.tabs.includes(tab));
  }

  function hasSplitAPI(splitter) {
    return Array.isArray(splitter?._data) && [
      "splitTabs", "removeNode", "splitIntoNode", "activateSplitView",
    ].every(name => typeof splitter[name] === "function");
  }

  function snapshotTree(root) {
    const nodes = [];
    const visit = node => {
      nodes.push({ node, parent: node.parent, size: node.sizeInParent,
        position: node.positionToRoot, children: node.children ? [...node.children] : null });
      node.children?.forEach(visit);
    };
    visit(root);
    return () => {
      for (const entry of nodes) {
        if (entry.children) {
          entry.node.children = entry.children;
        }
        entry.node.parent = entry.parent;
        entry.node.sizeInParent = entry.size;
        entry.node.positionToRoot = entry.position;
      }
      return root;
    };
  }

  // Let Zen handle tab groups, session state and containers, then relocate the
  // newly admitted leaf. Removing its temporary root slot restores sibling sizes.
  function splitTab(splitter, targetTab, newTab, side) {
    const existingGroup = findGroup(splitter, targetTab);
    const prepend = side === "left" || side === "top";
    const tabs = existingGroup || !prepend ? [targetTab, newTab] : [newTab, targetTab];
    const gridType = existingGroup ? undefined :
      (side === "left" || side === "right" ? "vsep" : "hsep");
    const result = splitter.splitTabs(tabs, gridType, tabs.indexOf(newTab));
    const group = result ?? findGroup(splitter, newTab);
    if (!group || !group.tabs.includes(newTab)) {
      throw new Error("Zen did not admit the link tab to split view.");
    }
    if (!existingGroup) {
      return group;
    }
    const targetNode = findLeaf(group.layoutTree, targetTab);
    const newNode = findLeaf(group.layoutTree, newTab);
    if (!targetNode || !newNode || targetNode === newNode) {
      throw new Error("Zen's split layout is missing a tab leaf.");
    }
    const restoreTree = snapshotTree(group.layoutTree);
    try {
      splitter.removeNode(newNode);
      splitter.splitIntoNode(targetNode, newNode, side, 0.5);
      splitter.activateSplitView(group, true);
    } catch (error) {
      group.layoutTree = restoreTree();
      splitter.activateSplitView(group, true);
      throw error;
    }
    return group;
  }

  class LinkDropController {
    constructor(win, services) {
      this.win = win;
      this.services = services;
      this.listeners = [];
      this.preview = null;
      this.destroyed = false;
      this.startupObserver = null;
      this.observingPrefs = false;
      this.prefObserver = { observe: () => this.hidePreview() };
    }

    listen(target, type, callback, capture = false) {
      target.addEventListener(type, callback, capture);
      this.listeners.push(() => target.removeEventListener(type, callback, capture));
    }

    start() {
      this.listen(this.win, "unload", () => this.destroy());
      if (this.win.gBrowserInit?.delayedStartupFinished) {
        this.attach();
      } else {
        this.startupObserver = subject => {
          if (subject !== this.win) {
            return;
          }
          this.services.obs.removeObserver(this.startupObserver, "browser-delayed-startup-finished");
          this.startupObserver = null;
          this.attach();
        };
        this.services.obs.addObserver(this.startupObserver, "browser-delayed-startup-finished");
      }
    }

    attach() {
      this.listen(this.win, "dragover", event => this.onDragOver(event), true);
      this.listen(this.win, "drop", event => this.onDrop(event), true);
      this.listen(this.win, "dragend", () => this.hidePreview(), true);
      this.listen(this.win, "dragleave", event => {
        if (!event.relatedTarget) {
          this.hidePreview();
        }
      }, true);
      this.listen(this.win, "keydown", event => {
        if (event.key === "Escape" || event.key === "Alt") {
          this.hidePreview();
        }
      }, true);
      this.listen(this.win, "blur", () => this.hidePreview());
      this.listen(this.win, "TabSelect", () => this.hidePreview());
      this.listen(this.win, "resize", () => this.hidePreview());
      this.services.prefs.addObserver(PREF_PREFIX, this.prefObserver);
      this.observingPrefs = true;
    }

    isSameWindow(transfer) {
      // Remote content drags expose their top-level WindowContext rather than
      // the page's DOM node. Compare browsing contexts, including iframe drags.
      const sourceContext = transfer.sourceTopWindowContext?.browsingContext;
      if (sourceContext) {
        const top = sourceContext.top ?? sourceContext;
        return top === this.win.browsingContext ||
          this.win.gBrowser.browsers.some(browser => browser.browsingContext?.top === top);
      }
      const source = transfer.mozSourceNode;
      if (!source) {
        return false;
      }
      const owner = source.ownerGlobal ?? source.ownerDocument?.defaultView;
      return owner === this.win || owner?.top === this.win;
    }

    getDropPlan(event) {
      if (this.destroyed || event.altKey || !event.isTrusted ||
          !this.services.prefs.getBoolPref(`${PREF_PREFIX}enabled`, true) ||
          !isLinkTransfer(event.dataTransfer) || !this.isSameWindow(event.dataTransfer) ||
          linkDropEffect(event.dataTransfer) === "none") {
        return null;
      }
      const splitter = this.win.gZenViewSplitter;
      if (!hasSplitAPI(splitter)) {
        return null;
      }
      const selectedTab = this.win.gBrowser.selectedTab;
      const activeGroup = findGroup(splitter, selectedTab);
      const tabs = activeGroup?.tabs ?? [selectedTab];
      for (const tab of tabs) {
        if (!tab || tab.closing || tab.hidden || ["zen-empty-tab", "zen-essential",
          "zen-glance-tab", "zen-live-folder-item-id"].some(name => tab.hasAttribute(name))) {
          continue;
        }
        const rect = tab.linkedBrowser.getBoundingClientRect();
        const side = chooseSide(rect, event.clientX, event.clientY, Boolean(activeGroup));
        if (!side) {
          continue;
        }
        const maxTabs = splitter.MAX_TABS ?? 4;
        const blocked = Boolean(activeGroup && activeGroup.tabs.length >= maxTabs);
        return { tab, rect, side, blocked };
      }
      return null;
    }

    getLink(event, validate) {
      const handler = this.services.droppedLinkHandler;
      const links = validate ? handler.dropLinks(event, true) : handler.queryLinks(event.dataTransfer);
      return links.length === 1 && isWebURL(links[0].url) ? links[0] : null;
    }

    consume(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    onDragOver(event) {
      try {
        const plan = this.getDropPlan(event);
        if (!plan || !this.getLink(event, false)) {
          this.hidePreview();
          return;
        }
        this.consume(event);
        event.dataTransfer.dropEffect = plan.blocked ? "none" : linkDropEffect(event.dataTransfer);
        this.showPreview(plan);
      } catch {
        this.hidePreview();
      }
    }

    onDrop(event) {
      this.hidePreview();
      let newTab;
      const selectedBefore = this.win.gBrowser.selectedTab;
      try {
        const plan = this.getDropPlan(event);
        if (!plan || !this.getLink(event, false)) {
          return;
        }
        // Consume before validation, so a rejected URL cannot navigate the pane.
        this.consume(event);
        if (plan.blocked) {
          return;
        }
        const link = this.getLink(event, true);
        if (!link) {
          return;
        }
        const handler = this.services.droppedLinkHandler;
        const options = {
          triggeringPrincipal: handler.getTriggeringPrincipal(event),
          allowInheritPrincipal: false,
          userContextId: Number(plan.tab.getAttribute("usercontextid")) || 0,
          pinned: Boolean(plan.tab.pinned),
          inBackground: true,
          skipAnimation: true,
          skipRoute: true,
        };
        // Support both current Firefox and older Zen bases.
        if (typeof handler.getPolicyContainer === "function") {
          options.policyContainer = handler.getPolicyContainer(event);
        } else if (typeof handler.getCSP === "function") {
          options.csp = handler.getCSP(event);
        }
        newTab = this.win.gBrowser.addTab(link.url, options);
        if (!newTab) {
          throw new Error("Zen did not create the link tab.");
        }
        splitTab(this.win.gZenViewSplitter, plan.tab, newTab, plan.side);
        this.win.gBrowser.selectedTab = newTab;
      } catch (error) {
        if (newTab && !newTab.closing) {
          try {
            this.win.gBrowser.removeTab(newTab, { animate: false });
          } catch (cleanupError) {
            this.win.console.error("[Link Drop Split] Could not close the failed link tab:", cleanupError);
          }
          if (selectedBefore && !selectedBefore.closing) {
            this.win.gBrowser.selectedTab = selectedBefore;
          }
        }
        this.win.console.error("[Link Drop Split] Could not split the dropped link:", error);
      }
    }

    showPreview(plan) {
      if (!this.services.prefs.getBoolPref(`${PREF_PREFIX}preview`, true)) {
        this.hidePreview();
        return;
      }
      if (!this.preview) {
        const doc = this.win.document;
        this.preview = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        this.preview.id = "zen-link-drop-split-preview";
        this.preview.setAttribute("aria-hidden", "true");
        this.preview.appendChild(doc.createElementNS("http://www.w3.org/1999/xhtml", "span"));
        doc.documentElement.appendChild(this.preview);
      }
      const rect = plan.blocked ? plan.rect : previewRect(plan.rect, plan.side);
      for (const key of ["left", "top", "width", "height"]) {
        this.preview.style[key] = `${rect[key]}px`;
      }
      this.preview.toggleAttribute("data-blocked", plan.blocked);
      this.preview.firstChild.textContent = plan.blocked ? "Split view is full" : "Open link here";
      this.preview.hidden = false;
    }

    hidePreview() {
      if (this.preview) {
        this.preview.hidden = true;
      }
    }

    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      this.listeners.splice(0).forEach(remove => remove());
      if (this.startupObserver) {
        this.services.obs.removeObserver(this.startupObserver, "browser-delayed-startup-finished");
        this.startupObserver = null;
      }
      if (this.observingPrefs) {
        this.services.prefs.removeObserver(PREF_PREFIX, this.prefObserver);
        this.observingPrefs = false;
      }
      this.preview?.remove();
      this.preview = null;
      if (this.win[WINDOW_KEY] === this) {
        delete this.win[WINDOW_KEY];
      }
    }
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { chooseSide, previewRect, isWebURL, isLinkTransfer, linkDropEffect, findLeaf,
      splitTab, LinkDropController };
  }
  if (typeof window !== "undefined" &&
      window.location.href === "chrome://browser/content/browser.xhtml") {
    window[WINDOW_KEY]?.destroy();
    const controller = new LinkDropController(window, Services);
    window[WINDOW_KEY] = controller;
    window.addUnloadListener?.(() => controller.destroy());
    controller.start();
  }
})();
