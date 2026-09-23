# Qandy Virtual Keyboard — extension skeleton

A working starting point, ported from the `keyboard()` component in `cylon4.htm`.
It's an MVP: full letter/number/symbol grid, shift/caps, backspace, arrows,
home/end, enter — enough to test the concept end-to-end on a real page.

## Try it (Chrome / Edge / Brave)
1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Visit any page with a text field (a search box is a good test) and tap into it

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json`.
Firefox is fine with this manifest since it doesn't use MV3-only APIs, but you'll
want a `browser_specific_settings` block before publishing.

## What's already ported vs. what's still original-only
| Feature | Status |
|---|---|
| Full key layout, dual-char shift/caps | ✅ ported |
| Slide-up overlay, landscape auto-expands (vh/vw grid) | ✅ ported |
| Live injection into `<input>`/`<textarea>`/`contenteditable` | ✅ new (page never had this) |
| Real `input`/`keydown`/`keyup`/`keypress` events so site JS (autocomplete, validation, enter-to-submit) still fires | ✅ new |
| Two-line word-wrapped preview with precise click-to-position cursor (`measureLineGeometry`/`buildLineSpans` in the original) | ⛔ simplified to a single scrolling preview line — portable but loses exact cursor math |
| Ctrl/Alt combos, F-keys | ⛔ keys render but are no-ops — see "Known limits" |
| Password field dot-masking in preview | ✅ ported |

## Known limits (worth knowing before you go further)
- **Address bar**: not reachable from a content script — see the chat answer for why, and the `chrome.omnibox` / `chrome.tabs.update` alternatives.
- **Cross-origin iframes** (e.g. a payment widget embedded from another domain): `all_frames: true` gets our script running *inside* that iframe too, so focus detection and injection still work — but each frame gets its own independent overlay instance. Worth adding a `postMessage` handshake later so only the top frame ever shows the visible keyboard, and it forwards keys down to whichever frame actually has focus.
- **`document.execCommand('insertText', ...)`** (used for `contenteditable`) is deprecated but still broadly supported; some rich editors (Google Docs, some WYSIWYG frameworks) use their own internal state and may not respond to it. That'll need per-editor handling if you hit one.
- **Ctrl/Alt/F-keys** are currently decorative. If you want real shortcuts (Ctrl+A select-all, Ctrl+C/V), those need `document.execCommand('selectAll'/'copy'/'paste')` or Selection/Range API calls — `KeyboardEvent` alone won't trigger a browser's built-in shortcut behavior since those aren't scriptable from JS for security reasons.
- **Sites that don't use real `<input>` elements** (some custom editors render fake carets over a `<div>`) won't be caught by `isEditable()` — you'd extend that check per-site as you find cases.

## Suggested next steps
1. Test on a handful of real sites (Google search, a login form, a `<textarea>` comment box) to see how the injected `input` events behave against each site's own JS.
2. Decide on the address-bar UX (own overlay + `chrome.tabs.update`, or skip it — the omnibox typing experience isn't really replaceable).
3. Rebuild the two-line cursor-accurate preview if you want the exact Tandy-style rendering back.
4. Add a toolbar icon + `chrome.storage` setting to toggle the keyboard on/off per-site (some sites you'll want your OS's normal keyboard instead).
