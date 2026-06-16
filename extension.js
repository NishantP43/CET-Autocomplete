// Emacs Tab Complete
// -------------------
// Re-implements Emacs `dabbrev-expand` (dynamic abbreviation), wrapped the way
// `hippie-expand` cycles candidates:
//
//   1. Take the word/prefix immediately before the cursor as the "abbreviation".
//   2. Search the current document BACKWARD first, then FORWARD, then other
//      open documents, for words that start with that prefix.
//   3. Insert the nearest match.
//   4. Pressing Tab again cycles to the next match; after the last one it
//      returns to your originally typed prefix and starts the cycle over.
//
// When there is no word before the cursor (or no match), Tab falls back to the
// normal editor Tab behaviour (indent / insert tab).

const vscode = require('vscode');

const DEFAULT_WORD_CHARS = 'A-Za-z0-9_$';

/**
 * Active expansion session, used to cycle through candidates on repeated Tab.
 * @type {null | {
 *   uri: string,
 *   prefix: string,
 *   prefixStart: number,   // offset where the abbreviation starts
 *   cycle: string[],       // candidates..., then the original prefix (for wrap)
 *   index: number,
 *   insertedEnd: number,   // offset of the cursor right after our last insert
 *   version: number        // document.version right after our last insert
 * }}
 */
let session = null;

function getConfig() {
  const c = vscode.workspace.getConfiguration('emacsTabComplete');
  return {
    enabled: c.get('enabled', true),
    wordChars: c.get('wordCharacters', DEFAULT_WORD_CHARS) || DEFAULT_WORD_CHARS,
    searchAll: c.get('searchAllOpenDocuments', true),
    fallbackToTab: c.get('fallbackToTab', true),
  };
}

function wordRegex(wordChars) {
  return new RegExp('[' + wordChars + ']+', 'g');
}

/** The run of word characters ending exactly at `position`, if any. */
function prefixAt(document, position, wordChars) {
  const line = document.lineAt(position.line).text;
  const upto = line.slice(0, position.character);
  const m = upto.match(new RegExp('[' + wordChars + ']+$'));
  if (!m) return null;
  const prefix = m[0];
  const start = new vscode.Position(position.line, position.character - prefix.length);
  return { prefix, start };
}

/**
 * Collect candidate completions for `prefix`, dabbrev-ordered:
 * nearest occurrence backward first, then forward, then other documents.
 */
function collectCandidates(document, cursorOffset, prefix, wordChars, searchAll) {
  const before = []; // { word, offset }
  const after = [];
  const re = wordRegex(wordChars);
  const text = document.getText();
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    if (word.length <= prefix.length || !word.startsWith(prefix)) continue;
    const offset = m.index;
    const end = offset + word.length;
    // Skip the word currently being typed (the run that contains the cursor).
    if (offset < cursorOffset && end > cursorOffset) continue;
    if (end <= cursorOffset) before.push({ word, offset });
    else after.push({ word, offset });
  }
  before.sort((a, b) => b.offset - a.offset); // nearest backward first
  after.sort((a, b) => a.offset - b.offset);  // nearest forward next

  const seen = new Set();
  const ordered = [];
  for (const item of before.concat(after)) {
    if (!seen.has(item.word)) {
      seen.add(item.word);
      ordered.push(item.word);
    }
  }

  if (searchAll) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc === document) continue;
      if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') continue;
      const re2 = wordRegex(wordChars);
      let mm;
      const t = doc.getText();
      while ((mm = re2.exec(t)) !== null) {
        const word = mm[0];
        if (word.length <= prefix.length || !word.startsWith(prefix)) continue;
        if (!seen.has(word)) {
          seen.add(word);
          ordered.push(word);
        }
      }
    }
  }

  return ordered;
}

async function fallbackTab(cfg) {
  session = null;
  if (cfg.fallbackToTab) {
    await vscode.commands.executeCommand('tab');
  }
}

async function expand() {
  const cfg = getConfig();
  const editor = vscode.window.activeTextEditor;
  if (!editor || !cfg.enabled) return fallbackTab(cfg);

  // Only operate on a single, empty selection. Otherwise behave like Tab.
  if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
    return fallbackTab(cfg);
  }

  const document = editor.document;
  const position = editor.selection.active;
  const cursorOffset = document.offsetAt(position);

  // --- Continuing an existing expansion -> cycle to next candidate. ---
  if (
    session &&
    session.uri === document.uri.toString() &&
    session.version === document.version &&
    session.insertedEnd === cursorOffset
  ) {
    session.index = (session.index + 1) % session.cycle.length;
    const next = session.cycle[session.index];
    const startPos = document.positionAt(session.prefixStart);
    const range = new vscode.Range(startPos, position);
    await editor.edit(
      (eb) => eb.replace(range, next),
      { undoStopBefore: false, undoStopAfter: false }
    );
    const newEnd = session.prefixStart + next.length;
    const newPos = editor.document.positionAt(newEnd);
    editor.selection = new vscode.Selection(newPos, newPos);
    session.insertedEnd = newEnd;
    session.version = editor.document.version;
    return;
  }

  // --- Start a new expansion. ---
  const info = prefixAt(document, position, cfg.wordChars);
  if (!info) return fallbackTab(cfg);

  const prefixStart = document.offsetAt(info.start);
  const candidates = collectCandidates(
    document,
    cursorOffset,
    info.prefix,
    cfg.wordChars,
    cfg.searchAll
  );
  if (candidates.length === 0) return fallbackTab(cfg);

  // hippie-expand style: candidates..., then back to the original prefix.
  const cycle = candidates.concat([info.prefix]);
  const first = cycle[0];
  const range = new vscode.Range(info.start, position);
  await editor.edit(
    (eb) => eb.replace(range, first),
    { undoStopBefore: true, undoStopAfter: false }
  );
  const newEnd = prefixStart + first.length;
  const newPos = editor.document.positionAt(newEnd);
  editor.selection = new vscode.Selection(newPos, newPos);

  session = {
    uri: document.uri.toString(),
    prefix: info.prefix,
    prefixStart,
    cycle,
    index: 0,
    insertedEnd: newEnd,
    version: editor.document.version,
  };
}

// ---------------------------------------------------------------------------
// Ctrl+Tab : list every function / method across the workspace and insert a
// full, overridable stub for the one you pick.
// ---------------------------------------------------------------------------

// Identifiers that can appear in a `<type> <name>(` shape but are NOT method
// definitions (control flow / statements). Used to reject false positives.
const NON_TYPE_KEYWORDS = new Set([
  'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'catch', 'do',
  'new', 'super', 'delete', 'throw', 'in', 'use', 'package', 'import',
]);

// Matches a CM method / free-function definition:
//   [modifiers] <returnType> <name>(<params>) {
// Anchored to line start so calls / declarations mid-line don't match. The
// param list is lazy and may span lines; it must terminate at `) {`.
// eslint-disable-next-line max-len
const METHOD_RE = /(^|\n)([ \t]*)((?:(?:public|private|protected|package|static|const|abstract|final|virtual|extend|override)\s+)*)([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*(?:\s*\[\s*\])?)\s+([A-Za-z_]\w*)\s*\(([^;{}]*?)\)\s*\{/g;

const PACKAGE_RE = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/m;
const CLASS_RE = /\bclass\s+([A-Za-z_]\w*)/g;

/** Build a sorted list of class declarations with their start offsets. */
function classRanges(text) {
  const ranges = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(text)) !== null) {
    ranges.push({ name: m[1], offset: m.index });
  }
  return ranges;
}

/** The class whose declaration most closely precedes `offset`, if any. */
function enclosingClass(ranges, offset) {
  let name = null;
  for (const r of ranges) {
    if (r.offset <= offset) name = r.name;
    else break;
  }
  return name;
}

/** Parse one document's text into method/function descriptors. */
function parseMethods(text, fileLabel) {
  const pkgMatch = text.match(PACKAGE_RE);
  const pkg = pkgMatch ? pkgMatch[1] : '';
  const ranges = classRanges(text);
  const out = [];
  let m;
  METHOD_RE.lastIndex = 0;
  while ((m = METHOD_RE.exec(text)) !== null) {
    const modifiers = m[3].replace(/\s+/g, ' ').trim();
    const returnType = m[4].trim();
    const name = m[5];
    if (NON_TYPE_KEYWORDS.has(returnType) || NON_TYPE_KEYWORDS.has(name)) continue;
    const params = m[6].replace(/\s+/g, ' ').trim();
    // Offset of the actual definition (after the leading newline + indent).
    const defOffset = m.index + m[1].length + m[2].length;
    const line = text.slice(0, defOffset).split('\n').length;
    out.push({
      name,
      params,
      returnType,
      modifiers,
      className: enclosingClass(ranges, defOffset),
      pkg,
      fileLabel,
      line,
    });
  }
  return out;
}

/** Escape a literal string so it is inert inside a VS Code snippet. */
function escapeSnippet(s) {
  return s.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/}/g, '\\}');
}

/** Build the inserted, overridable method stub as a snippet. */
function methodStub(d) {
  const mods = d.modifiers ? d.modifiers + ' ' : '';
  const sig = `${mods}${d.returnType} ${d.name}(${d.params})`;
  const isVoid = /\bvoid\b/.test(d.returnType);
  const body = isVoid ? 'super(..);' : 'return super(..);';
  return new vscode.SnippetString(
    `${escapeSnippet(sig)} {\n\t\${0:${escapeSnippet(body)}}\n}`
  );
}

// The word to seed the picker with: the active selection, or the identifier
// the cursor sits on / right after. Returns { text, range } or null.
function seedPrefix(editor) {
  const sel = editor.selection;
  if (!sel.isEmpty) {
    const text = editor.document.getText(sel).trim();
    if (text) return { text, range: sel };
  }
  const wordRe = /[A-Za-z_$][\w$]*/;
  const range = editor.document.getWordRangeAtPosition(sel.active, wordRe);
  if (range) return { text: editor.document.getText(range), range };
  return null;
}

async function listMethods() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a file to insert a method into.');
    return;
  }

  const seed = seedPrefix(editor);

  const descriptors = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Scanning .cm files for methods…' },
    async () => {
      const exclude = '**/{node_modules,.git,out,dist,build}/**';
      const uris = await vscode.workspace.findFiles('**/*.cm', exclude);
      const decoder = new TextDecoder('utf-8');
      const all = [];
      // Read in batches to avoid opening thousands of handles at once.
      const batchSize = 64;
      for (let i = 0; i < uris.length; i += batchSize) {
        const batch = uris.slice(i, i + batchSize);
        const texts = await Promise.all(
          batch.map(async (uri) => {
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              return { uri, text: decoder.decode(bytes) };
            } catch (e) {
              return null;
            }
          })
        );
        for (const r of texts) {
          if (!r) continue;
          const label = vscode.workspace.asRelativePath(r.uri);
          for (const d of parseMethods(r.text, label)) {
            d.uri = r.uri;
            all.push(d);
          }
        }
      }
      return all;
    }
  );

  if (!descriptors || descriptors.length === 0) {
    vscode.window.showInformationMessage('No methods found in any .cm files in the workspace.');
    return;
  }

  descriptors.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.className || '').localeCompare(b.className || '') ||
      a.fileLabel.localeCompare(b.fileLabel)
  );

  const items = descriptors.map((d) => ({
    label: `${d.name}(${d.params})`,
    description: `${d.returnType}${d.className ? '  ·  ' + d.className : '  ·  <free>'}`,
    detail: `${d.pkg || d.fileLabel}  —  ${d.fileLabel}:${d.line}`,
    descriptor: d,
  }));

  // Use a QuickPick (not showQuickPick) so we can pre-seed the filter with the
  // word the cursor is on, e.g. typing `allowsnap` then Ctrl+Tab immediately
  // narrows the list to matching methods.
  const pick = await new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.title = `Methods across workspace  (${items.length})`;
    qp.placeholder = seed
      ? `Completing “${seed.text}” — pick a method, or clear to see all…`
      : 'Type to filter by method name, class, package, or file…';
    if (seed) qp.value = seed.text;
    qp.onDidAccept(() => {
      const chosen = qp.selectedItems[0];
      qp.hide();
      resolve(chosen);
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(undefined);
    });
    qp.show();
  });
  if (!pick) return;

  const d = pick.descriptor;
  // Insert the full overridable stub (signature with params + super body).
  // When a word/selection seeded the picker, the stub replaces it in place;
  // otherwise it is inserted at the cursor.
  await editor.insertSnippet(methodStub(d), seed ? seed.range : undefined);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('emacsTabComplete.expand', expand),
    vscode.commands.registerCommand('emacsTabComplete.listMethods', listMethods),
    vscode.window.onDidChangeActiveTextEditor(() => {
      session = null;
    })
  );
}

function deactivate() {
  session = null;
}

module.exports = { activate, deactivate };
