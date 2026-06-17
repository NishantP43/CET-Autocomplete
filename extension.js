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

// Everything in this extension is scoped to CM (.cm) source files only.
const CM_SELECTOR = [
  { scheme: 'file', pattern: '**/*.cm' },
  { scheme: 'untitled', pattern: '**/*.cm' },
];

/** True when the document is a .cm file (the only files we operate on). */
function isCmDocument(document) {
  return !!document && /\.cm$/i.test(document.uri.fsPath || document.fileName || '');
}

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
      if (!isCmDocument(doc)) continue;
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

  // Only operate on .cm files; elsewhere Tab behaves normally.
  if (!isCmDocument(editor.document)) return fallbackTab(cfg);

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
  if (!isCmDocument(editor.document)) {
    vscode.window.showInformationMessage('This command only works in .cm files.');
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

// ---------------------------------------------------------------------------
// Dot-triggered member completion  (type "obj."  →  members of obj's class)
// ---------------------------------------------------------------------------

/** memberCache: Map<className, { methods: Map<name, descriptor> }> */
let memberCache = null;
let memberCacheTime = 0;
const MEMBER_CACHE_TTL_MS = 30_000; // 30 s; also invalidated on file save

/** Parse all .cm workspace files and return a class → methods map. */
async function buildMemberCache() {
  const exclude = '**/{node_modules,.git,out,dist,build}/**';
  const uris = await vscode.workspace.findFiles('**/*.cm', exclude);
  const decoder = new TextDecoder('utf-8');
  const classMap = new Map();

  const batchSize = 64;
  for (let i = 0; i < uris.length; i += batchSize) {
    const batch = uris.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (uri) => {
        try { return decoder.decode(await vscode.workspace.fs.readFile(uri)); }
        catch { return null; }
      })
    );
    for (const text of results) {
      if (!text) continue;
      const ranges = classRanges(text);
      METHOD_RE.lastIndex = 0;
      let m;
      while ((m = METHOD_RE.exec(text)) !== null) {
        const returnType = m[4].trim();
        const name = m[5];
        if (NON_TYPE_KEYWORDS.has(returnType) || NON_TYPE_KEYWORDS.has(name)) continue;
        const params = m[6].replace(/\s+/g, ' ').trim();
        const defOffset = m.index + m[1].length + m[2].length;
        const className = enclosingClass(ranges, defOffset);
        if (!className) continue;
        if (!classMap.has(className)) classMap.set(className, { methods: new Map() });
        classMap.get(className).methods.set(name, {
          name, params, returnType,
          modifiers: m[3].replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return classMap;
}

async function getMemberCache() {
  const now = Date.now();
  if (!memberCache || now - memberCacheTime > MEMBER_CACHE_TTL_MS) {
    memberCache = await buildMemberCache();
    memberCacheTime = now;
  }
  return memberCache;
}

/**
 * Scan backward in text before cursorOffset for a declaration `TypeName varName`
 * and return TypeName.  Only considers types starting with an uppercase letter.
 */
function inferType(text, cursorOffset, varName) {
  const snippet = text.slice(0, cursorOffset);
  const re = new RegExp(`\\b([A-Z][A-Za-z_\\w]*)(?:\\[\\])?\\s+${varName}\\b`, 'g');
  let best = null;
  let m;
  while ((m = re.exec(snippet)) !== null) best = m[1];
  return best;
}

/**
 * Collect all `objectName.XXX` identifiers seen in open buffers as a fallback
 * when static type inference cannot resolve the class.
 */
function corpusMembers(objectName) {
  const re = new RegExp(`\\b${objectName}\\.(\\w+)`, 'g');
  const seen = new Set();
  for (const doc of vscode.workspace.textDocuments) {
    if (!isCmDocument(doc)) continue;
    re.lastIndex = 0;
    let m;
    const text = doc.getText();
    while ((m = re.exec(text)) !== null) seen.add(m[1]);
  }
  return [...seen];
}

function makeDotMemberProvider() {
  return {
    async provideCompletionItems(document, position) {
      const cfg = getConfig();
      if (!cfg.enabled) return null;

      // Find the last dot at or before the cursor on this line.
      const line = document.lineAt(position.line).text;
      const beforeCursor = line.slice(0, position.character);
      const dotIndex = beforeCursor.lastIndexOf('.');
      if (dotIndex === -1) return null;

      // Extract the identifier immediately before the dot.
      const beforeDot = beforeCursor.slice(0, dotIndex);
      const idMatch = beforeDot.match(/([A-Za-z_$][\w$]*)$/);
      if (!idMatch) return null;
      const objectName = idMatch[1];

      // The text the user may have typed after the dot (partial member name).
      const partialRange = new vscode.Range(
        position.line, dotIndex + 1,
        position.line, position.character
      );

      const completions = [];
      const addedNames = new Set();

      try {
        const classMap = await getMemberCache();
        const cursorOffset = document.offsetAt(position);

        // If the identifier starts with uppercase treat it as the class itself
        // (static / factory access); otherwise infer type from variable declarations.
        const className = /^[A-Z]/.test(objectName)
          ? objectName
          : inferType(document.getText(), cursorOffset, objectName);

        if (className && classMap.has(className)) {
          for (const [, method] of classMap.get(className).methods) {
            const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
            item.detail = `${method.returnType}  ·  ${className}`;
            item.documentation = `${method.modifiers ? method.modifiers + ' ' : ''}${method.returnType} ${method.name}(${method.params})`;
            item.insertText = new vscode.SnippetString(
              method.params.length > 0
                ? `${method.name}(\${1:${escapeSnippet(method.params)}})`
                : `${method.name}()`
            );
            item.filterText = method.name;
            item.sortText = '0' + method.name;
            item.range = partialRange;
            completions.push(item);
            addedNames.add(method.name);
          }
        }
      } catch (_) { /* cache miss — fall through to corpus */ }

      // Corpus fallback: every `objectName.xxx` seen across open buffers.
      for (const member of corpusMembers(objectName)) {
        if (addedNames.has(member)) continue;
        const item = new vscode.CompletionItem(member, vscode.CompletionItemKind.Property);
        item.detail = 'corpus';
        item.sortText = '1' + member;
        item.range = partialRange;
        completions.push(item);
        addedNames.add(member);
      }

      return completions.length > 0 ? completions : null;
    },
  };
}

/**
 * CompletionItemProvider — mirrors cm-ac-source-candidates in Emacs:
 * the same dabbrev candidate list exposed to VS Code's IntelliSense dropdown.
 */
function makeDabbrevProvider() {
  return {
    provideCompletionItems(document, position) {
      const cfg = getConfig();
      if (!cfg.enabled) return null;

      const info = prefixAt(document, position, cfg.wordChars);
      if (!info) return null;

      const cursorOffset = document.offsetAt(position);
      const candidates = collectCandidates(
        document,
        cursorOffset,
        info.prefix,
        cfg.wordChars,
        cfg.searchAll
      );
      if (candidates.length === 0) return null;

      return candidates.map((word, i) => {
        const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
        // Preserve dabbrev ordering (nearest match first) in the sorted list.
        item.sortText = String(i).padStart(6, '0');
        item.detail = 'dabbrev';
        return item;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CM-style indentation  (replicates Emacs `cm-indent-command` + untabify)
//
// In Emacs, CM files use cc-mode's `c-indent-command` configured like this
// (base/emacs/cm-bindings.el, emacs20/cm.el, cm-edit.el):
//
//     c-basic-offset        4     one indent level = 4 spaces
//     substatement-open     0     a block's { sits under its statement
//     substatement          *     a braceless substatement body: +2 (half)
//     statement-cont        *     line continuations: +2 (half)
//     case-label            *     case/default labels: +2 (half)
//     statement-case-intro  *     body under a case label: +2 from the label
//     cpp-macro             0     #-preprocessor lines: column 0
//
// `cm-indent-command` first runs `whitespace-cleanup-region` — the "untabify":
// tabs become spaces and trailing whitespace is stripped.
//
// cc-mode is a large stateful parser; this is a pragmatic brace/paren-depth
// reimplementation that matches the settings above for ordinary CM code.
// It is line-based and free of editor side effects (pure text in, text out).
// ---------------------------------------------------------------------------

function indentConfig() {
  const c = vscode.workspace.getConfiguration('emacsTabComplete');
  return {
    indentSize: c.get('indentSize', 4),
    tabWidth: c.get('tabWidth', 8),
  };
}

/** Expand every tab to spaces by column position — Emacs `untabify`. */
function untabify(line, tabWidth) {
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = tabWidth - (col % tabWidth);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/**
 * Blank out comments and string/char literals on one line so the remaining
 * characters can be scanned for brackets safely. Returns the masked code
 * (same length), the carried block-comment state, and—when a block comment
 * opens on this line—the column of its `/*` (for `*`-alignment of the box).
 */
function maskLine(line, state) {
  let masked = '';
  let i = 0;
  let inBlock = state.inBlockComment;
  let blockCol = state.blockCommentCol;
  let openedBlockCol = null;
  let inStr = null; // '"' or "'" while inside a literal
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; masked += '  '; i += 2; continue; }
      masked += ' '; i += 1; continue;
    }
    if (inStr) {
      if (ch === '\\') { masked += '  '; i += 2; continue; }
      if (ch === inStr) inStr = null;
      masked += ' '; i += 1; continue;
    }
    if (ch === '/' && next === '/') { masked += ' '.repeat(line.length - i); break; }
    if (ch === '/' && next === '*') {
      inBlock = true;
      if (openedBlockCol === null) openedBlockCol = i;
      masked += '  '; i += 2; continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; masked += ' '; i += 1; continue; }
    masked += ch; i += 1;
  }
  return {
    masked,
    inBlockComment: inBlock,
    blockCommentCol: inBlock ? (state.inBlockComment ? blockCol : openedBlockCol) : 0,
    openedBlockCol,
  };
}

/**
 * Reformat `text` CM-style: untabified, trailing whitespace stripped, and
 * re-indented per the cc-mode offsets above. Returns an array of new lines.
 */
function reformatLines(text, cfg) {
  const half = Math.round(cfg.indentSize / 2);
  const raw = text.split(/\r\n|\r|\n/);
  const out = [];
  let depth = 0;     // net open brackets {([ before the current line
  let parens = 0;    // net open ( and [ (arglists) before the current line
  let cont = false;  // the previous statement continues onto this line
  const state = { inBlockComment: false, blockCommentCol: 0 };

  for (let li = 0; li < raw.length; li++) {
    const line = untabify(raw[li], cfg.tabWidth).replace(/[ \t]+$/, '');
    const trimmed = line.trim();

    if (trimmed === '') { out.push(''); cont = false; continue; }

    // --- Indent for this line, computed from state BEFORE its own brackets. ---
    let indent;
    if (state.inBlockComment) {
      // Inside a /* */ box: align the leading '*' (and prose) one past the '/*'.
      indent = state.blockCommentCol + 1;
    } else if (trimmed.startsWith('#')) {
      indent = 0; // cpp-macro 0
    } else {
      indent = depth * cfg.indentSize;
      const first = trimmed[0];
      if (first === '}' || first === ')' || first === ']') {
        indent -= cfg.indentSize;               // closing bracket dedents
      } else if (/^(case\b|default\b\s*:)/.test(trimmed)) {
        indent -= half;                          // case-label *
      }
      // statement-cont *: a continued statement gets +half, but a line that
      // merely opens/closes a block is not itself a continuation.
      if (cont && parens === 0 && first !== '{' && first !== '}') indent += half;
      if (indent < 0) indent = 0;
    }

    const newLine = ' '.repeat(indent) + trimmed;
    out.push(newLine);

    // --- Update bracket depth / comment state / continuation for next line. ---
    const r = maskLine(newLine, state);
    state.inBlockComment = r.inBlockComment;
    state.blockCommentCol = r.blockCommentCol;

    for (const ch of r.masked) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === '(' || ch === '[') { depth++; parens++; }
      else if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); parens = Math.max(0, parens - 1); }
    }

    if (state.inBlockComment || parens > 0) {
      cont = parens > 0 ? false : cont; // inside an arglist depth handles it
      if (state.inBlockComment) cont = false;
    } else {
      const codeTrim = r.masked.replace(/[ \t]+$/, '');
      const last = codeTrim[codeTrim.length - 1];
      cont = !(codeTrim === '' || last === ';' || last === '{' || last === '}' || last === ':');
    }
  }
  return out;
}

/** Build TextEdits that reindent either the whole document or one line range. */
function reindentEdits(document, range) {
  const cfg = indentConfig();
  const newLines = reformatLines(document.getText(), cfg);
  const edits = [];
  const start = range ? range.start.line : 0;
  const end = range ? range.end.line : document.lineCount - 1;
  for (let i = start; i <= end && i < newLines.length && i < document.lineCount; i++) {
    const old = document.lineAt(i);
    if (old.text !== newLines[i]) edits.push(vscode.TextEdit.replace(old.range, newLines[i]));
  }
  return edits;
}

/** Command: reindent + untabify the selection (if any) or the whole buffer. */
async function reindentBuffer() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCmDocument(editor.document)) {
    vscode.window.showInformationMessage('Open a .cm file to reindent.');
    return;
  }
  const sel = editor.selection;
  const range = sel.isEmpty
    ? null
    : new vscode.Range(sel.start.line, 0, sel.end.line, 0);
  const edits = reindentEdits(editor.document, range);
  if (edits.length === 0) return;
  await editor.edit((eb) => {
    for (const e of edits) eb.replace(e.range, e.newText);
  });
}

function makeFormattingProvider() {
  return {
    provideDocumentFormattingEdits(document) {
      return reindentEdits(document, null);
    },
    provideDocumentRangeFormattingEdits(document, range) {
      return reindentEdits(document, range);
    },
    // Electric reindent on newline / closing brace (needs editor.formatOnType).
    provideOnTypeFormattingEdits(document, position) {
      const line = position.line;
      return reindentEdits(document, new vscode.Range(line, 0, line, 0));
    },
  };
}

function activate(context) {
  const dotProvider = makeDotMemberProvider();
  const formatter = makeFormattingProvider();
  context.subscriptions.push(
    vscode.commands.registerCommand('emacsTabComplete.expand', expand),
    vscode.commands.registerCommand('emacsTabComplete.listMethods', listMethods),
    vscode.window.onDidChangeActiveTextEditor(() => {
      session = null;
    }),
    // Invalidate the member cache whenever a .cm file is saved.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith('.cm')) memberCache = null;
    }),
    // Dabbrev IntelliSense dropdown (word-prefix matching across buffers).
    vscode.languages.registerCompletionItemProvider(
      CM_SELECTOR,
      makeDabbrevProvider()
    ),
    // Dot-triggered member completion: "obj."  →  methods of obj's class.
    vscode.languages.registerCompletionItemProvider(
      CM_SELECTOR,
      dotProvider,
      '.'
    ),
    // CM-style indentation (cc-mode offsets) + untabify, like Emacs.
    vscode.commands.registerCommand('emacsTabComplete.reindentBuffer', reindentBuffer),
    vscode.languages.registerDocumentFormattingEditProvider(CM_SELECTOR, formatter),
    vscode.languages.registerDocumentRangeFormattingEditProvider(CM_SELECTOR, formatter),
    vscode.languages.registerOnTypeFormattingEditProvider(CM_SELECTOR, formatter, '}')
  );
}

function deactivate() {
  session = null;
}

module.exports = { activate, deactivate };
