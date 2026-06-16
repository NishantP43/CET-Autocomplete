# Emacs Tab Complete

Bring Emacs's **`dabbrev-expand` / `hippie-expand`** word completion to VS Code.

Type a prefix, press <kbd>Tab</kbd>, and the word is completed from text that
already exists in your open files. Press <kbd>Tab</kbd> again to **cycle**
through the other matches. When there is nothing to complete, <kbd>Tab</kbd>
does its normal job (indent / insert tab).

## How it mirrors Emacs

Emacs's dynamic abbreviation works like this, and so does this extension:

1. The word characters immediately before the cursor are taken as the
   **abbreviation** (prefix).
2. Candidates are searched **backward first, then forward** in the current
   document, then across **other open documents** — nearest match wins.
3. The nearest match is inserted.
4. Repeating <kbd>Tab</kbd> cycles to the next match; after the last one it
   returns to your original typed prefix and starts over.

This is language-agnostic: it works in any file type because it completes from
the literal words in your buffers, exactly like dabbrev.

## Example

```
function getUserName() {}

getUs▏          ← press Tab
getUserName▏    ← completed (nearest match)
                  press Tab again → next match, … → back to "getUs"
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `emacsTabComplete.enabled` | `true` | Enable/disable the extension. |
| `emacsTabComplete.wordCharacters` | `A-Za-z0-9_$` | Regex character-class contents defining a "word" (the abbreviation alphabet). |
| `emacsTabComplete.searchAllOpenDocuments` | `true` | Also gather candidates from other open documents. |
| `emacsTabComplete.fallbackToTab` | `true` | When nothing matches, perform the normal Tab (indent). |

## Keybinding

Bound to <kbd>Tab</kbd> while editing, but only when no suggestion/snippet UI is
active, so it never fights VS Code's IntelliSense:

```
editorTextFocus && !editorReadonly && !suggestWidgetVisible &&
!inSnippetMode && !editorTabMovesFocus && !inlineSuggestionVisible
```

## Ctrl+Tab — insert a method stub from anywhere in the workspace

Press <kbd>Ctrl</kbd>+<kbd>Tab</kbd> while editing to open a searchable dropdown
of **every function and method defined in any `.cm` file across the workspace**
(all packages). Filter by method name, class, package, or file. Selecting one
inserts a complete, overridable stub at the cursor:

```
public str partPrefix(Object env=null) {
    return super(..);   ← selected; type to replace
}
```

> Note: this rebinds <kbd>Ctrl</kbd>+<kbd>Tab</kbd> (normally the editor
> switcher) while the editor is focused. Rebind it in
> *File → Preferences → Keyboard Shortcuts* (search "List Methods Across
> Workspace") if you'd rather keep Ctrl+Tab for switching editors.

## Install (local)

```sh
code --install-extension emacs-tab-complete-0.0.2.vsix
```

## License

MIT
