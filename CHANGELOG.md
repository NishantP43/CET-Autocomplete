# Changelog

## 1.0.3

- The navigation index now warms up in the background a few seconds after VS
  Code starts, so even the first Go to Definition / List Parents / etc. is
  instant instead of waiting for the initial workspace scan.

## 1.0.2

- Go to Definition now uses the same progress-aware index as the other CM
  Navigate commands, so every navigate function (Go to Definition, List
  Parents, Subclasses, Class Methods, Overrides) shows the indexing progress on
  the first call and traverses the full class hierarchy across the workspace,
  base/ included.

## 1.0.1

- CM Navigate commands now show an "Indexing .cm classes…" progress notification
  while the workspace index builds (the first call scans the whole tree, base/
  included, which can take ~20s), so it no longer looks like nothing happened.
- I lengthened the class-index lifetime to 5 minutes (still refreshed on save),
  so List Parents/Subclasses/etc. are instant after the first build. List
  Parents walks the full extends chain to the root class (verified to `Object`).

## 1.0.0

- I made the Ctrl+Tab method picker fast: it caches the workspace scan (rebuilt
  only after saves / every 60s) and narrows results to the word under the
  cursor — or, with no word, to the current file's package — then caps the list
  (default 2000, `emacsTabComplete.methodPickerMaxItems`). No more building
  tens of thousands of items every time.
- First stable release. Includes: Tab dabbrev completion, object dot-member
  completion (inheritance-aware), the Ctrl+Tab method browser, CM indentation
  & untabify, and CM Navigate (Go to Definition, List Parents / Subclasses /
  Class Methods / Overrides) with Emacs-style key bindings.

## 0.0.14

- I moved the CM Navigate shortcuts off the `Ctrl+C` prefix so Copy keeps
  working in `.cm` files: List Overrides `Ctrl+Alt+O`, List Subclasses
  `Ctrl+Alt+S`, List Parents `Ctrl+Alt+D`, List Class Methods `Ctrl+Alt+A`.
  Go to Definition `Alt+.` and Pop Back `Ctrl+Alt+I` are unchanged.

## 0.0.13

- I scoped **List Overrides** to the method's class hierarchy (ancestors +
  subclasses) instead of listing every same-named method in the workspace.
- I added the same Emacs key bindings (in `.cm` files): List Overrides
  `C-c C-o`, List Subclasses `C-c C-s`, List Parents `C-c C-d`, List Class
  Methods `C-c C-a`, Go to Definition `M-.`, Pop Back `C-M-i`.

## 0.0.12

- I added CM Navigate features from the Emacs menu: **Go to Definition** (F12 /
  Ctrl+Click on a class or method jumps to where it's defined), and the
  right-click commands **List Class Methods**, **List Subclasses**,
  **List Parents**, and **List Overrides of Method** — all from a workspace
  index of `.cm` classes and their `extends` chains.
- Not included: Go To Next/Prev/First Error (needs the CM compiler's
  diagnostics); Pop Back From Definition is VS Code's built-in Go Back (Alt+Left).

## 0.0.11

- I rewrote the CM reindenter to match how the codebase is actually written:
  K&R braces, multi-line `if`/`while` conditions and argument lists now align
  to their opening paren, and braceless `if`/`else`/loop bodies get a half-step.
  Block comments (including `/* CUT THIS OUT */` regions) are preserved verbatim.

## 0.0.9

- **Dot-member completion now follows inheritance.** Typing `obj.` lists the
  methods declared on `obj`'s class **and every method inherited up the
  `extends` chain** (e.g. an `AboBaseCover` shows `HonBaseCover`'s methods too).
  Own methods sort first, inherited methods next (tagged "(inherited)" with the
  declaring class), and a subclass override shadows the base.

## 0.0.8

- **Dot-triggered member completion (`.cm` only).** Type `obj.` and the
  members of `obj`'s class appear, resolved by scanning backward for the
  variable's declared type (or treating an uppercase name as the class itself).
  Falls back to a corpus scan of `obj.xxx` usages across open `.cm` buffers.
- **CM-style indentation + untabify**, mirroring Emacs `cm-indent-command`
  (cc-mode offsets: 4-space levels, half-indent for `case:` / continuations,
  `#` lines to column 0). Run it via **Ctrl+Alt+\\** (selection, or whole
  buffer when nothing is selected), the **Reindent / Untabify (CM)** command,
  or **Format Document**. Tabs become spaces and trailing whitespace is
  stripped. New settings: `emacsTabComplete.indentSize`, `tabWidth`.
- All completion, expansion, and indentation features are now scoped to
  `.cm` files, and candidate sources are limited to other open `.cm` buffers.

## 0.0.4

- Completing from a typed word now inserts the **full overridable stub** — the
  real parameter list plus a `super(..)` body (`return super(..);` for
  non-void, `super(..);` for void) — replacing the typed word in place, instead
  of just `name()`.

## 0.0.3

- **Ctrl+Tab now seeds the picker with the word under the cursor / selection.**
  Type `allowsnap`, press Ctrl+Tab, and the dropdown opens already filtered to
  matching methods. Clear the box to browse everything.
- When a word/selection is present, picking a method **autocompletes in place**
  (replaces the word with `methodName()`, cursor inside the parens) instead of
  inserting a stub. With no word under the cursor it still inserts the full
  overridable stub.

## 0.0.2

- New: **Ctrl+Tab** lists every function/method across all `.cm` files in the
  workspace in a searchable dropdown (filter by method name, class, package, or
  file). Selecting one inserts a full, overridable method stub
  (`return super(..);` body) at the cursor.

## 0.0.1

- Initial release.
- Emacs `dabbrev` / `hippie-expand` style Tab completion from buffer words.
- Nearest-first ordering (backward, then forward, then other open documents).
- Tab cycles through candidates and wraps back to the original prefix.
- Falls back to normal Tab (indent) when there is nothing to complete.
