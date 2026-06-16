# Changelog

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
