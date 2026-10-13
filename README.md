# Link Drop Split

A [Sine](https://github.com/CosmoCreeper/Sine) JavaScript mod for Zen Browser. Drag a web link from a page in your current window and drop it into the content area to open it in a split tab.

## Drop behavior

- **First split:** drop in the left or right quarter, halfway down the page, for side-by-side panes (horizontal layout). Drop in the top or bottom quarter for stacked panes (vertical layout). The top and bottom zones span the full width, including the corners. The central area retains ordinary drop behavior.
- **Later splits:** drop anywhere inside the pane you want to divide. A wide pane divides into left/right halves; a tall pane divides into top/bottom halves. The pointer chooses which half receives the new link. A square pane uses the first-split zones to choose an axis, with left/right as the center fallback.
- **Other panes stay in place**, including panes you have resized. Each accepted drop creates a new tab and focuses it.
- A translucent preview marks the new pane before you release the link.
- The mod respects Zen's pane limit (currently four). A full split displays “Split view is full” and refuses the drop without replacing a page.
- Hold **Alt** while dropping to use ordinary browser/page drop behavior. **Escape** cancels the drag.

Links can move between panes or originate in an iframe, provided they belong to the same browser window. The new tab uses the target pane's container and pinned state. Browser tabs, files, image drags, text selections, external drags, and multiple links use ordinary behavior. Only `http:` and `https:` links are handled. Blank URI-list lines (including trailing CRLF) are ignored when counting links; Firefox still validates the complete transfer before a tab opens. Browser chrome inputs, controls, and overlays retain ordinary drop behavior even when they overlap a pane. Essential tabs, Glance overlays, empty split placeholders, and live-folder items are excluded.

## Install with Sine

Install this repository as a custom Sine mod; it does not require a build step.

1. Install [Sine and its bootloader](https://github.com/CosmoCreeper/Sine#installation) in Zen if you have not already.
2. Open Zen's Settings → Sine and find the custom GitHub repository input.
3. Paste `https://github.com/rrpanda/zen-link-drop-split` and install the mod.
4. Enable the mod. For unpublished JavaScript mods, enable Sine's **Allow unsafe JS** setting (`sine.allow-unsafe-js`) if Sine requires it to load the script.
5. Restart Zen after initial installation and try dragging a link to the right-hand middle of a page.

The mod settings let you enable/disable link splitting and its preview independently. Changes take effect immediately. Sine can unload the script when you disable or uninstall the mod; existing split tabs remain normal Zen split views.

For development after a Sine installation, edit the files in your profile's `chrome/sine-mods/zen-link-drop-split/` directory, then restart Zen. Find the profile root through `about:profiles`. Disable automatic updates for the mod while editing installed files so your changes are retained.

## Verification

Node.js 22 or later is sufficient; there are no npm dependencies.

```sh
npm run check
npm test
npm run test:native
```

`npm test` exercises realistic URI-list CRLF/comment/blank and multiple-link payloads, page/iframe versus chrome target filtering, drop-zone selection, pane targeting, transfer filtering, source-window checks, URL validation, container and pinned state, limits, preview preferences, failure cleanup, and startup/unload behavior using browser-service mocks.

`npm run test:native` downloads [Zen's splitter implementation at a pinned commit](https://github.com/zen-browser/desktop/blob/bce6a23ea7082967bc27a92ae8613a4b04f3dae3/src/zen/split-view/ZenViewSplitter.mjs) to a temporary directory and executes its real layout and tab-admission methods. Only browser UI/services are stubbed. The checks cover all four first-split directions, three/four-pane nested layouts, preservation of resized siblings, pinned tabs, and rollback after an insertion failure. An internet connection is required. To check a different Zen revision:

```sh
ZEN_SPLITTER_REF=dev npm run test:native
```

The [compatibility workflow](.github/workflows/compatibility.yml) runs syntax and unit checks on Node 22, plus native layout checks against both the pinned revision and current `dev`, on pushes, pull requests, manual runs, and a weekly schedule. These source checks stub browser UI services and do not establish live integration compatibility.

### Manual checks in Zen

Open [tests/drag-links.html](tests/drag-links.html) in the Zen window where you installed the mod, or use any page with ordinary web links.

1. Drag a link to the right middle: the original page stays left and the link opens right.
2. Reset the split and drop a link at the top: the link opens above the original page.
3. Start with a side-by-side split. Drop another link on a tall pane near its bottom: only that pane divides into stacked halves.
4. Start with a stacked split. Drop another link on a wide pane near its right edge: only that pane divides into side-by-side halves.
5. Resize a sibling pane, then split the other pane. Verify the sibling retains its size and position.
6. Drop in an unfocused pane. Verify that pane is the one divided and the new tab is focused.
7. Reach the pane limit and try another link. Verify no tab opens and no existing page navigates.
8. Try an iframe link, a pinned page, a container tab, and a private window. Confirm the destination stays in the same window and retains the target container/pinned state.
9. Try a tab drag, text selection, file/image drag, cross-window link, and Alt-drop. Verify ordinary behavior remains available.
10. Drag the fixture’s explicit URI-list sources: trailing CRLF/comments/blank lines should open one split; two URLs and non-web URLs should retain ordinary behavior.
11. Drag a link onto browser chrome controls and overlays, including an address-bar input, find bar, and any popup over a pane. Verify no split preview or tab opens; normal control behavior remains available. Compare a page input and an iframe content target, which remain eligible in split zones.
12. Cancel a drag or leave the content area. Verify the preview disappears. Disable the mod through Sine and verify link splitting stops.

These manual checks have not been run in a live Zen instance in this workspace: no Zen or Firefox executable was available. A Chromium preview cannot verify privileged Zen scripts. Remote-content event retargeting, source-window isolation, actual focus, Sine unload, private windows, and containers remain unverified in live Zen; automated checks cover handler and layout logic with service mocks.

## Compatibility

This mod calls Zen's internal [`gZenViewSplitter` APIs](https://github.com/zen-browser/desktop/blob/dev/src/zen/split-view/ZenViewSplitter.mjs), including its layout tree. Browser updates can change those APIs. When the required methods are missing, the mod leaves ordinary drop behavior available. It does not change `zen.splitView.enable-tab-drop` or replace Zen's native tab drag handlers.

URL validation and navigation principals come from Firefox's [dropped-link service](https://github.com/mozilla-firefox/firefox/blob/main/dom/base/ContentAreaDropListener.sys.mjs). The mod registers its script and cleanup callback through [Sine's loader and manager](https://github.com/CosmoCreeper/Sine/tree/main/src/core).
