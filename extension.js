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
  { language: 'cm', scheme: 'file' },
  { language: 'cm', scheme: 'untitled' },
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
// Captures the class name and, optionally, the `extends Base[, Base2]` clause.
const CLASS_RE = /\bclass\s+([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))?/g;

/** Parse an `extends` clause into a list of simple base-class names. */
function parseBases(extendsClause) {
  if (!extendsClause) return [];
  return extendsClause
    .split(',')
    .map((s) => s.trim().split('.').pop()) // strip package qualifiers
    .filter(Boolean);
}

/** Build a sorted list of class declarations with their start offsets + bases. */
function classRanges(text) {
  const ranges = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(text)) !== null) {
    ranges.push({ name: m[1], offset: m.index, bases: parseBases(m[2]) });
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

// Cached flat list of every method descriptor across the workspace, so the
// Ctrl+Tab picker scans the files only once per TTL (and after saves) instead
// of re-reading thousands of files on every invocation.
let methodDescCache = null;
let methodDescTime = 0;
const METHOD_DESC_TTL_MS = 60_000;

async function getMethodDescriptors() {
  const exclude = '**/{node_modules,.git,out,dist,build}/**';
  const uris = await vscode.workspace.findFiles('**/*.cm', exclude);
  const decoder = new TextDecoder('utf-8');
  const all = [];
  const batchSize = 64;
  for (let i = 0; i < uris.length; i += batchSize) {
    const batch = uris.slice(i, i + batchSize);
    const texts = await Promise.all(
      batch.map(async (uri) => {
        try { return { uri, text: decoder.decode(await vscode.workspace.fs.readFile(uri)) }; }
        catch { return null; }
      })
    );
    for (const r of texts) {
      if (!r) continue;
      const label = vscode.workspace.asRelativePath(r.uri);
      for (const d of parseMethods(r.text, label)) { d.uri = r.uri; all.push(d); }
    }
  }
  return all;
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
  const maxItems = vscode.workspace.getConfiguration('emacsTabComplete').get('methodPickerMaxItems', 2000);

  // Use the cache when warm; only show the scanning progress when (re)building.
  let descriptors;
  if (methodDescCache && Date.now() - methodDescTime < METHOD_DESC_TTL_MS) {
    descriptors = methodDescCache;
  } else {
    descriptors = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Indexing .cm methods…' },
      getMethodDescriptors
    );
    methodDescCache = descriptors;
    methodDescTime = Date.now();
  }

  if (!descriptors || descriptors.length === 0) {
    vscode.window.showInformationMessage('No methods found in any .cm files in the workspace.');
    return;
  }

  // Narrow the candidate set so the picker stays small and fast:
  //  • with a word under the cursor, keep only methods whose name matches it;
  //  • otherwise, restrict to the current file's package.
  const myPkg = (editor.document.getText().match(PACKAGE_RE) || [])[1] || '';
  let filtered = descriptors;
  let scope = 'workspace';
  if (seed && seed.text) {
    const q = seed.text.toLowerCase();
    filtered = descriptors.filter((d) => d.name.toLowerCase().includes(q));
    scope = `matching “${seed.text}”`;
  } else if (myPkg) {
    filtered = descriptors.filter((d) => d.pkg === myPkg);
    scope = myPkg;
  }
  if (filtered.length === 0) { filtered = descriptors; scope = 'workspace'; }

  filtered.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.className || '').localeCompare(b.className || '') ||
      a.fileLabel.localeCompare(b.fileLabel)
  );

  const total = filtered.length;
  const capped = total > maxItems;
  if (capped) filtered = filtered.slice(0, maxItems);

  const items = filtered.map((d) => ({
    label: `${d.name}(${d.params})`,
    description: `${d.returnType}${d.className ? '  ·  ' + d.className : '  ·  <free>'}`,
    detail: `${d.pkg || d.fileLabel}  —  ${d.fileLabel}:${d.line}`,
    descriptor: d,
  }));

  const pick = await new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.title = `Methods (${scope})  ·  ${capped ? maxItems + ' of ' + total : total}`;
    qp.placeholder = seed
      ? `Completing “${seed.text}” — pick a method…`
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
      // Register every class (and its bases) up front, even if it has no
      // methods of its own — so inheritance chains can still be walked.
      for (const r of ranges) {
        if (!classMap.has(r.name)) classMap.set(r.name, { methods: new Map(), bases: [] });
        if (r.bases.length) classMap.get(r.name).bases = r.bases;
      }
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
        if (!classMap.has(className)) classMap.set(className, { methods: new Map(), bases: [] });
        classMap.get(className).methods.set(name, {
          name, params, returnType,
          modifiers: m[3].replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return classMap;
}

/**
 * All methods usable on an instance of `className`: its own methods plus every
 * method inherited up the `extends` chain. A subclass override shadows the
 * base. Returns Map<methodName, { method, owner }>.
 */
function resolveMembers(classMap, className) {
  const result = new Map();
  const seen = new Set();
  const walk = (cn) => {
    if (!cn || seen.has(cn)) return;
    seen.add(cn);
    const entry = classMap.get(cn);
    if (!entry) return;
    for (const [name, method] of entry.methods) {
      if (!result.has(name)) result.set(name, { method, owner: cn }); // nearest wins
    }
    for (const base of entry.bases || []) walk(base);
  };
  walk(className);
  return result;
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
          // Own methods + everything inherited up the `extends` chain.
          for (const [, { method, owner }] of resolveMembers(classMap, className)) {
            const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
            const inherited = owner !== className;
            item.detail = `${method.returnType}  ·  ${owner}${inherited ? ' (inherited)' : ''}`;
            item.documentation = `${method.modifiers ? method.modifiers + ' ' : ''}${method.returnType} ${method.name}(${method.params})`;
            item.insertText = new vscode.SnippetString(
              method.params.length > 0
                ? `${method.name}(\${1:${escapeSnippet(method.params)}})`
                : `${method.name}()`
            );
            item.filterText = method.name;
            // Own methods sort first (0), inherited next (1), corpus last (handled below).
            item.sortText = (inherited ? '1' : '0') + method.name;
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
        item.sortText = '2' + member;
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
 * re-indented. Returns an array of new lines.
 *
 * Uses a stack of open brackets. A `{` opens a *block*: its body indents one
 * level past the enclosing block (4 spaces), and its `}` lines up with the
 * statement that opened it — so K&R braces (`if (...) {`), `} else {`, loops,
 * and method bodies all come out right. A `(` or `[` opens an *arglist*:
 * continuation lines align to the column just after the bracket (cc-mode
 * arglist style), so multi-line `if`/`while` conditions and call argument
 * lists stay aligned to their opening paren.
 */
function reformatLines(text, cfg) {
  const size = cfg.indentSize;
  const half = Math.round(size / 2);
  const raw = text.split(/\r\n|\r|\n/);
  const out = [];
  const stack = []; // { ch:'{'|'('|'[', openerIndent, contentIndent }
  let cont = false; // a non-bracket statement continues onto the next line
  const state = { inBlockComment: false, blockCommentCol: 0 };

  // Indentation of the body of the nearest enclosing `{` block (0 at top level).
  const enclosingBlockContent = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].ch === '{') return stack[i].contentIndent;
    }
    return 0;
  };

  for (let li = 0; li < raw.length; li++) {
    const line = untabify(raw[li], cfg.tabWidth).replace(/[ \t]+$/, '');
    const trimmed = line.trim();

    if (trimmed === '') { out.push(''); cont = false; continue; }

    // Inside a /* */ block comment: keep the interior exactly as written
    // (only untabified + trailing-stripped). Free-form prose and example code
    // must never be re-indented.
    if (state.inBlockComment) {
      out.push(line);
      const rc = maskLine(line, state);
      state.inBlockComment = rc.inBlockComment;
      state.blockCommentCol = rc.blockCommentCol;
      cont = false;
      continue;
    }

    const top = stack.length ? stack[stack.length - 1] : null;
    const inParen = !!top && (top.ch === '(' || top.ch === '[');

    // --- Indent for this line, from state BEFORE its own brackets. ---
    let indent;
    if (trimmed.startsWith('#')) {
      indent = 0;                                 // cpp-macro 0
    } else {
      const first = trimmed[0];
      if (first === '}' || first === ')' || first === ']') {
        indent = top ? top.openerIndent : 0;      // closer lines up with opener
      } else {
        indent = top ? top.contentIndent : 0;
        // CM code indents `case:`/`default:` at the full block level (not the
        // half-step cc-mode default), so they need no special dedent here.
        // A braceless substatement / continued line gets a half step, matching
        // cc-mode `substatement *` and `statement-cont *`.
        if (cont && !inParen) indent += half;
      }
      if (indent < 0) indent = 0;
    }

    const newLine = ' '.repeat(indent) + trimmed;
    out.push(newLine);

    // --- Update bracket stack / comment state from this line's code. ---
    const r = maskLine(newLine, state);
    state.inBlockComment = r.inBlockComment;
    state.blockCommentCol = r.blockCommentCol;
    const code = r.masked;

    for (let k = 0; k < code.length; k++) {
      const ch = code[k];
      if (ch === '{') {
        const base = enclosingBlockContent();
        stack.push({ ch: '{', openerIndent: base, contentIndent: base + size });
      } else if (ch === '(' || ch === '[') {
        // Align continuations to the first char after the bracket; if nothing
        // follows on this line, hang one level under the opener.
        let contentCol = -1;
        for (let j = k + 1; j < newLine.length; j++) {
          if (newLine[j] !== ' ' && newLine[j] !== '\t') { contentCol = j; break; }
        }
        stack.push({
          ch,
          openerIndent: indent,
          contentIndent: contentCol !== -1 ? contentCol : indent + size,
        });
      } else if (ch === '}' || ch === ')' || ch === ']') {
        if (stack.length) stack.pop();
      }
    }

    // --- Does this line continue (no terminator, not inside an arglist)? ---
    const newTop = stack.length ? stack[stack.length - 1] : null;
    const stillInParen = !!newTop && (newTop.ch === '(' || newTop.ch === '[');
    if (state.inBlockComment || stillInParen) {
      cont = false;
    } else {
      const codeTrim = code.replace(/[ \t]+$/, '');
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

// ---------------------------------------------------------------------------
// CM Navigate — Go to Definition + class/method browsing, mirroring the Emacs
// "CM Navigate" menu. (The compiler-error items — Go To Next/Prev/First Error —
// are omitted: they require the real CM compiler's diagnostics. "Pop Back From
// Definition" is VS Code's built-in Go Back, Alt+Left.)
// ---------------------------------------------------------------------------

let symbolIndex = null;
let symbolIndexTime = 0;
const SYMBOL_TTL_MS = 300_000; // 5 min; also invalidated whenever a .cm is saved

/** 1-based line number containing byte offset `off`. */
function lineOf(text, off) {
  return text.slice(0, off).split('\n').length;
}

/** Scan every workspace .cm file into a location-aware class/method index. */
async function buildSymbolIndex() {
  const exclude = '**/{node_modules,.git,out,dist,build}/**';
  const uris = await vscode.workspace.findFiles('**/*.cm', exclude);
  const decoder = new TextDecoder('utf-8');
  const classes = new Map();       // name -> { name, uri, line, bases, methods:[{name,params,returnType,line}] }
  const methodsByName = new Map();  // name -> [{ className, uri, line, params, returnType }]

  const batch = 64;
  for (let i = 0; i < uris.length; i += batch) {
    const chunk = uris.slice(i, i + batch);
    const texts = await Promise.all(
      chunk.map(async (uri) => {
        try { return { uri, text: decoder.decode(await vscode.workspace.fs.readFile(uri)) }; }
        catch { return null; }
      })
    );
    for (const r of texts) {
      if (!r) continue;
      const { uri, text } = r;
      const ranges = classRanges(text);
      for (const rg of ranges) {
        if (!classes.has(rg.name)) {
          classes.set(rg.name, {
            name: rg.name, uri, line: lineOf(text, rg.offset), bases: rg.bases, methods: [],
          });
        } else if (rg.bases.length && !classes.get(rg.name).bases.length) {
          classes.get(rg.name).bases = rg.bases;
        }
      }
      METHOD_RE.lastIndex = 0;
      let m;
      while ((m = METHOD_RE.exec(text)) !== null) {
        const returnType = m[4].trim();
        const name = m[5];
        if (NON_TYPE_KEYWORDS.has(returnType) || NON_TYPE_KEYWORDS.has(name)) continue;
        const defOffset = m.index + m[1].length + m[2].length;
        const line = lineOf(text, defOffset);
        const params = m[6].replace(/\s+/g, ' ').trim();
        const className = enclosingClass(ranges, defOffset);
        if (!methodsByName.has(name)) methodsByName.set(name, []);
        methodsByName.get(name).push({ className, uri, line, params, returnType });
        if (className && classes.has(className)) {
          classes.get(className).methods.push({ name, params, returnType, line });
        }
      }
    }
  }
  return { classes, methodsByName };
}

async function getSymbolIndex() {
  const now = Date.now();
  if (!symbolIndex || now - symbolIndexTime > SYMBOL_TTL_MS) {
    symbolIndex = await buildSymbolIndex();
    symbolIndexTime = now;
  }
  return symbolIndex;
}

/** Like getSymbolIndex, but shows a progress notification while (re)building. */
async function getSymbolIndexWithProgress() {
  if (symbolIndex && Date.now() - symbolIndexTime <= SYMBOL_TTL_MS) return symbolIndex;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Indexing .cm classes…' },
    () => getSymbolIndex()
  );
}

/** A vscode.Location at the start of a 1-based line. */
function locAt(uri, line) {
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  return new vscode.Location(uri, pos);
}

/** The class the cursor is on (if the word is a class) or inside, else null. */
function classAtCursor(editor, idx) {
  const doc = editor.document;
  const wr = doc.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_$][\w$]*/);
  if (wr && idx.classes.has(doc.getText(wr))) return doc.getText(wr);
  const ranges = classRanges(doc.getText());
  return enclosingClass(ranges, doc.offsetAt(editor.selection.active));
}

/** Open a vscode.Location and place the cursor at its start. */
async function revealLocation(location) {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  const ed = await vscode.window.showTextDocument(doc);
  ed.selection = new vscode.Selection(location.range.start, location.range.start);
  ed.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
}

/**
 * Go to Definition — an explicit command (not a DefinitionProvider), so it only
 * runs when its key binding is pressed, never on Ctrl+Click or Ctrl+hover.
 */
async function goToDefinition() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCmDocument(editor.document)) {
    vscode.window.showInformationMessage('Open a .cm file.');
    return;
  }
  const wr = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_$][\w$]*/);
  if (!wr) { vscode.window.showInformationMessage('Put the cursor on a class or method name.'); return; }
  const word = editor.document.getText(wr);
  const idx = await getSymbolIndexWithProgress();
  const items = [];
  if (idx.classes.has(word)) {
    const c = idx.classes.get(word);
    items.push({ label: `class ${word}`, description: relUri(c.uri), location: locAt(c.uri, c.line) });
  }
  for (const mi of idx.methodsByName.get(word) || []) {
    items.push({
      label: `${word}(${mi.params})`,
      description: `${mi.returnType}  ·  ${mi.className || '<free>'}`,
      detail: relUri(mi.uri),
      location: locAt(mi.uri, mi.line),
    });
  }
  if (items.length === 0) { vscode.window.showInformationMessage(`No definition found for "${word}".`); return; }
  if (items.length === 1) return revealLocation(items[0].location);
  return pickAndJump(items, `Definitions of ${word}`);
}

/** Show a QuickPick of {label, description, detail, location} and jump to it. */
async function pickAndJump(items, placeHolder) {
  if (!items.length) { vscode.window.showInformationMessage('Nothing to show.'); return; }
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
  if (!pick || !pick.location) return;
  return revealLocation(pick.location);
}

const relUri = (uri) => vscode.workspace.asRelativePath(uri);

async function withClass(action, placeholder) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCmDocument(editor.document)) {
    vscode.window.showInformationMessage('Open a .cm file.');
    return;
  }
  const idx = await getSymbolIndexWithProgress();
  const cn = classAtCursor(editor, idx);
  if (!cn || !idx.classes.has(cn)) {
    vscode.window.showInformationMessage('Put the cursor inside (or on) a class name.');
    return;
  }
  return action(idx, cn, editor);
}

/** List Parents: the full extends chain of the current class. */
function listParents() {
  return withClass((idx, cn) => {
    const items = [];
    const seen = new Set();
    const walk = (name) => {
      const c = idx.classes.get(name);
      if (!c) return;
      for (const b of c.bases) {
        if (seen.has(b)) continue;
        seen.add(b);
        const bc = idx.classes.get(b);
        items.push({
          label: b,
          description: bc ? relUri(bc.uri) : '(not found in workspace)',
          location: bc ? locAt(bc.uri, bc.line) : null,
        });
        if (bc) walk(b);
      }
    };
    walk(cn);
    return pickAndJump(items, `Parents of ${cn}`);
  });
}

/** List Subclasses: every class that (transitively) extends the current one. */
function listSubclasses() {
  return withClass((idx, cn) => {
    const items = [];
    const seen = new Set();
    let frontier = [cn];
    while (frontier.length) {
      const next = [];
      for (const [name, c] of idx.classes) {
        if (c.bases.some((b) => frontier.includes(b)) && !seen.has(name)) {
          seen.add(name);
          next.push(name);
          items.push({ label: name, description: relUri(c.uri), location: locAt(c.uri, c.line) });
        }
      }
      frontier = next;
    }
    return pickAndJump(items, `Subclasses of ${cn}`);
  });
}

/** List Class Methods: own + inherited methods of the current class. */
function listClassMethods() {
  return withClass((idx, cn) => {
    const items = [];
    const seen = new Set();
    const walk = (name) => {
      const c = idx.classes.get(name);
      if (!c) return;
      for (const me of c.methods) {
        if (seen.has(me.name)) continue;       // nearest (override) wins
        seen.add(me.name);
        items.push({
          label: `${me.name}(${me.params})`,
          description: `${me.returnType}  ·  ${name}${name === cn ? '' : ' (inherited)'}`,
          location: locAt(c.uri, me.line),
        });
      }
      for (const b of c.bases) walk(b);
    };
    walk(cn);
    items.sort((a, b) => a.label.localeCompare(b.label));
    return pickAndJump(items, `Methods of ${cn}`);
  });
}

/** Ancestors (extends chain) of `cn`, as a Set of class names. */
function ancestorsOf(idx, cn) {
  const set = new Set();
  const up = (n) => {
    const c = idx.classes.get(n);
    if (!c) return;
    for (const b of c.bases) if (!set.has(b)) { set.add(b); up(b); }
  };
  up(cn);
  return set;
}

/** Transitive subclasses of `cn`, as a Set of class names. */
function subclassesOf(idx, cn) {
  const set = new Set();
  let frontier = [cn];
  while (frontier.length) {
    const next = [];
    for (const [name, c] of idx.classes) {
      if (!set.has(name) && c.bases.some((b) => frontier.includes(b))) { set.add(name); next.push(name); }
    }
    frontier = next;
  }
  return set;
}

/**
 * List Overrides: definitions of the method under the cursor within the
 * enclosing class's hierarchy (itself + ancestors it overrides, + subclasses
 * that override it). Falls back to all definitions when no class is in scope.
 */
function listOverrides() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCmDocument(editor.document)) {
    vscode.window.showInformationMessage('Open a .cm file.');
    return;
  }
  const wr = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_$][\w$]*/);
  if (!wr) { vscode.window.showInformationMessage('Put the cursor on a method name.'); return; }
  const name = editor.document.getText(wr);
  return getSymbolIndexWithProgress().then((idx) => {
    const cn = classAtCursor(editor, idx);
    let related = null;
    if (cn && idx.classes.has(cn)) {
      related = new Set([cn, ...ancestorsOf(idx, cn), ...subclassesOf(idx, cn)]);
    }
    const defs = (idx.methodsByName.get(name) || [])
      .filter((d) => d.className && (!related || related.has(d.className)));
    const items = defs.map((d) => ({
      label: `${name}(${d.params})`,
      description: `${d.returnType}  ·  ${d.className}`,
      detail: relUri(d.uri),
      location: locAt(d.uri, d.line),
    }));
    return pickAndJump(
      items,
      related ? `Overrides of ${name} in ${cn}'s hierarchy` : `Definitions of ${name}`
    );
  });
}

// ---------------------------------------------------------------------------
// Document Symbols — powers the Outline panel and breadcrumbs for .cm files.
// Shows package > class > method hierarchy.
// ---------------------------------------------------------------------------

// Regex for CM section header comments:
//    /***********************************************************************
//     * Section Name
//     ***********************************************************************/
const SECTION_HEADER_RE = /\/\*{5,}[\s\S]*?\n[ \t]*\*[ \t]+([^\n*]+?)[ \t]*\n[ \t]*\*{5,}\//g;

/** Parse section headers from text. Returns [{ name, offset, line }]. */
function parseSectionHeaders(text) {
  SECTION_HEADER_RE.lastIndex = 0;
  const headers = [];
  let m;
  while ((m = SECTION_HEADER_RE.exec(text)) !== null) {
    headers.push({
      name: m[1].trim(),
      offset: m.index,
      endOffset: m.index + m[0].length,
      line: text.slice(0, m.index).split('\n').length - 1,
      endLine: text.slice(0, m.index + m[0].length).split('\n').length - 1,
    });
  }
  return headers;
}

function makeDocumentSymbolProvider() {
  return {
    provideDocumentSymbols(document) {
      const text = document.getText();
      const symbols = [];
      const classStack = [];

      // Package
      const pkgM = text.match(PACKAGE_RE);
      if (pkgM) {
        const line = document.positionAt(pkgM.index);
        const range = new vscode.Range(line, line);
        symbols.push(new vscode.DocumentSymbol(
          pkgM[1], 'package', vscode.SymbolKind.Package, range, range
        ));
      }

      // Classes
      const ranges = classRanges(text);
      for (const r of ranges) {
        const pos = document.positionAt(r.offset);
        const range = new vscode.Range(pos, pos);
        const sym = new vscode.DocumentSymbol(
          r.name, r.bases.length ? `extends ${r.bases.join(', ')}` : '',
          vscode.SymbolKind.Class, range, range
        );
        sym.children = [];
        sym._cmName = r.name;
        sym._cmOffset = r.offset;
        classStack.push(sym);
      }

      // Section headers → region symbols inside their enclosing class
      const headers = parseSectionHeaders(text);
      for (const h of headers) {
        const startPos = new vscode.Position(h.line, 0);
        const endPos = new vscode.Position(h.endLine, 0);
        const range = new vscode.Range(startPos, endPos);
        const regionSym = new vscode.DocumentSymbol(
          `▸ ${h.name}`, 'region', vscode.SymbolKind.Namespace, range, range
        );
        regionSym._cmOffset = h.offset;
        regionSym.children = [];
        let parent = null;
        for (const cs of classStack) {
          if (cs._cmOffset <= h.offset) parent = cs;
          else break;
        }
        if (parent) parent.children.push(regionSym);
        else symbols.push(regionSym);
      }

      // Methods — assign to enclosing region (if any) or class
      METHOD_RE.lastIndex = 0;
      let m;
      while ((m = METHOD_RE.exec(text)) !== null) {
        const returnType = m[4].trim();
        const name = m[5];
        if (NON_TYPE_KEYWORDS.has(returnType) || NON_TYPE_KEYWORDS.has(name)) continue;
        const params = m[6].replace(/\s+/g, ' ').trim();
        const defOffset = m.index + m[1].length + m[2].length;
        const pos = document.positionAt(defOffset);
        const endPos = document.positionAt(defOffset + m[0].length);
        const range = new vscode.Range(pos, endPos);
        const methodSym = new vscode.DocumentSymbol(
          `${name}(${params})`, returnType, vscode.SymbolKind.Method, range, range
        );

        // Find enclosing class, then enclosing region within that class
        let parentClass = null;
        for (const cs of classStack) {
          if (cs._cmOffset <= defOffset) parentClass = cs;
          else break;
        }
        let parentRegion = null;
        if (parentClass) {
          for (const child of parentClass.children) {
            if (child._cmOffset !== undefined && child._cmOffset <= defOffset) parentRegion = child;
          }
        }

        if (parentRegion) parentRegion.children.push(methodSym);
        else if (parentClass) parentClass.children.push(methodSym);
        else symbols.push(methodSym);
      }

      for (const cs of classStack) symbols.push(cs);
      return symbols;
    },
  };
}

/** Folding ranges: each section header folds to the next one (or class end). */
function makeFoldingRangeProvider() {
  return {
    provideFoldingRanges(document) {
      const text = document.getText();
      const headers = parseSectionHeaders(text);
      const ranges = [];
      for (let i = 0; i < headers.length; i++) {
        const startLine = headers[i].line;
        const endLine = (i + 1 < headers.length)
          ? headers[i + 1].line - 1
          : document.lineCount - 1;
        if (endLine > startLine) {
          ranges.push(new vscode.FoldingRange(startLine, endLine, vscode.FoldingRangeKind.Region));
        }
      }
      return ranges;
    },
  };
}

/** Overview ruler + inline decorations for section headers. */
const sectionHeaderDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  overviewRulerColor: '#4488cc',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  minimap: { color: '#4488ccaa', position: vscode.MinimapPosition.Inline },
});

function refreshSectionDecorations(editor) {
  if (!editor || !isCmDocument(editor.document)) return;
  const headers = parseSectionHeaders(editor.document.getText());
  const decorations = headers.map((h) => ({
    range: new vscode.Range(h.line, 0, h.endLine, 0),
  }));
  editor.setDecorations(sectionHeaderDecoration, decorations);
}

// ---------------------------------------------------------------------------
// Hover — show class/method info when hovering over identifiers.
// ---------------------------------------------------------------------------

function makeHoverProvider() {
  return {
    async provideHover(document, position) {
      const wr = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
      if (!wr) return null;
      const word = document.getText(wr);
      const idx = await getSymbolIndex();
      const parts = [];

      if (idx.classes.has(word)) {
        const c = idx.classes.get(word);
        const bases = c.bases.length ? ` extends ${c.bases.join(', ')}` : '';
        parts.push(`**class ${word}**${bases}`);
        parts.push(`*${vscode.workspace.asRelativePath(c.uri)}:${c.line}*`);
        if (c.methods.length) {
          parts.push(`${c.methods.length} method(s)`);
        }
      }

      const methods = idx.methodsByName.get(word) || [];
      if (methods.length > 0 && methods.length <= 8) {
        for (const mi of methods) {
          parts.push(`\`${mi.returnType} ${word}(${mi.params})\` — ${mi.className || '<free>'}`);
        }
      } else if (methods.length > 8) {
        parts.push(`\`${word}\` — ${methods.length} definitions across the workspace`);
      }

      if (parts.length === 0) return null;
      return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')));
    },
  };
}

// ---------------------------------------------------------------------------
// Compiler Error Parsing — watch the CM terminal output for errors and create
// VS Code diagnostics (red squiggles + Problems panel).
// ---------------------------------------------------------------------------

const cmDiagnostics = vscode.languages.createDiagnosticCollection('cm');

function parseCmErrors(text) {
  // CM errors look like: "filename.cm:123,45: error: message"
  // or "filename.cm:123: error: message"
  // or just "filename.cm(123): error message"
  const re = /([A-Za-z]:[^\s:]+\.cm|[^\s:]+\.cm)[:\(](\d+)(?:[,:](\d+))?[\):]?\s*:?\s*(error|warning|Error|Warning)[:\s]+([^\n]+)/g;
  const byFile = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const file = m[1].replace(/\//g, pathMod.sep);
    const line = Math.max(0, parseInt(m[2], 10) - 1);
    const col = m[3] ? Math.max(0, parseInt(m[3], 10) - 1) : 0;
    const severity = /error/i.test(m[4])
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
    const message = m[5].trim();
    const range = new vscode.Range(line, col, line, col + 1);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(new vscode.Diagnostic(range, message, severity));
  }
  return byFile;
}

function updateDiagnosticsFromOutput(text) {
  const errors = parseCmErrors(text);
  cmDiagnostics.clear();
  for (const [file, diags] of errors) {
    try {
      cmDiagnostics.set(vscode.Uri.file(file), diags);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CM Runtime Interaction — mirrors the Emacs CM compilation buffer commands.
//
// In Emacs, CM runs in a `comint` subprocess buffer and the developer sends
// commands like `quit()`, `compile(...)`, `exit(0)`, etc. by pressing key
// chords that transmit the string to the process. In VS Code, the CM process
// runs in an integrated terminal. These commands find (or create) the CM
// terminal and send the corresponding text.
// ---------------------------------------------------------------------------

const CM_TERMINAL_NAME = 'CM Dev';

/** Find an existing CM terminal, or null. */
function findCmTerminal() {
  return vscode.window.terminals.find(
    (t) => t.name === CM_TERMINAL_NAME
  ) || vscode.window.activeTerminal || null;
}

/** Send a command string to the CM process (debug engine or terminal). */
function sendToCm(cmd) {
  if (cmDebugEngine && cmDebugEngine._process) {
    cmDebugEngine.send(cmd);
    if (cmDebugEngine._terminal) cmDebugEngine._terminal.show(true);
    return;
  }
  const term = findCmTerminal();
  if (!term) {
    vscode.window.showInformationMessage(
      'No CM terminal found. Start the CM process first (Ctrl+Alt+F5 or use "CM: Start Dev Process").'
    );
    return;
  }
  term.sendText(cmd);
  term.show(true);
}

/** Start the CM dev process in a dedicated terminal. */
function startCmDev() {
  const cfg = vscode.workspace.getConfiguration('emacsTabComplete');
  const cmHome = cfg.get('cmHome', '') || process.env.CM_UNIX_HOME || process.env.CM_HOME || '';
  const customCmd = cfg.get('cmStartCommand', '');
  let cmd;
  if (customCmd) {
    cmd = customCmd;
  } else if (cmHome) {
    const sep = process.platform === 'win32' ? '\\' : '/';
    const cmdFile = `${cmHome}${sep}bin${sep}cmstartdev.cmd`;
    cmd = `"${cmdFile}"`;
  } else {
    vscode.window.showInformationMessage(
      'Set emacsTabComplete.cmHome or emacsTabComplete.cmStartCommand, or set the CM_HOME / CM_UNIX_HOME env variable.'
    );
    return;
  }
  const existing = vscode.window.terminals.find((t) => t.name === CM_TERMINAL_NAME);
  if (existing) { existing.show(); existing.sendText(cmd); return; }
  const term = vscode.window.createTerminal({ name: CM_TERMINAL_NAME });
  term.show();
  term.sendText(cmd);
}

function resumeFromError() { sendToCm('quit();'); }
function resumeAndClear() { sendToCm('cm.core.debug.quitAndClear();'); }
function cmSendCompile() {
  const editor = vscode.window.activeTextEditor;
  if (editor && isCmDocument(editor.document)) {
    sendToCm(`compile("${editor.document.fileName.replace(/\\/g, '/')}", code=false);`);
  } else {
    sendToCm('compile(code=false);');
  }
}
function cmSendCompileAll() { sendToCm('compile(code=false);'); }
function cmSendCdb() { sendToCm('cdb();'); }
function cmSendExit() { sendToCm('exit(0);'); }
function cmSendStackTrace() { sendToCm('stackTrace();'); }
function cmSendStackDump() { sendToCm('stackDump();'); }
function cmSendInspect() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const file = editor.document.fileName.replace(/\\/g, '/');
  const pos = editor.document.offsetAt(editor.selection.active);
  sendToCm(`inspect("${file}", ${pos});`);
}
function cmSendCustom() {
  vscode.window.showInputBox({
    prompt: 'CM command to send to the runtime',
    placeHolder: 'pln("hello");',
  }).then((cmd) => { if (cmd) sendToCm(cmd); });
}
function cmRequestStop() {
  const cmWrite = process.env.CM_UNIX_WRITE || process.env.CM_WRITE || '';
  if (!cmWrite) {
    vscode.window.showInformationMessage('CM_UNIX_WRITE / CM_WRITE not set; cannot create stop file.');
    return;
  }
  const fs = require('fs');
  const path = require('path');
  const stopFile = path.join(cmWrite, 'data', 'stop');
  try { fs.mkdirSync(path.dirname(stopFile), { recursive: true }); } catch {}
  try { fs.writeFileSync(stopFile, ''); vscode.window.showInformationMessage('Stop requested.'); } catch (e) {
    vscode.window.showInformationMessage('Failed to create stop file: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// CM Debug Engine — a PseudoTerminal that wraps the CM process as a child
// process, giving both a visible terminal AND programmatic I/O. This enables
// stepping, variable inspection, and watches.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const pathMod = require('path');

let cmDebugEngine = null;

class CmDebugEngine {
  constructor() {
    this._writeEmitter = new vscode.EventEmitter();
    this._closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this._writeEmitter.event;
    this.onDidClose = this._closeEmitter.event;
    this._process = null;
    this._outputBuffer = '';
    this._evalResolve = null;
    this._evalMarker = null;
    this._terminal = null;
    // Debug state
    this.currentFile = null;
    this.currentLine = null; // 1-based
    this.inDebugPrompt = false;
    this._debugHighlight = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 255, 0, 0.2)',
      isWholeLine: true,
      overviewRulerColor: 'yellow',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    // Watch expressions
    this.watches = [];
    this._watchProvider = null;
    // Locals
    this._localsProvider = null;
    this._localsData = [];
  }

  open() {
    const cfg = vscode.workspace.getConfiguration('emacsTabComplete');
    const cmHome = cfg.get('cmHome', '') || process.env.CM_UNIX_HOME || process.env.CM_HOME || '';
    const customCmd = cfg.get('cmStartCommand', '');
    let cmd, args;
    if (customCmd) {
      const parts = customCmd.split(/\s+/);
      cmd = parts[0]; args = parts.slice(1);
    } else if (cmHome) {
      const sep = pathMod.sep;
      cmd = 'cmd'; args = ['/c', 'call', `${cmHome}${sep}bin${sep}cmstartdev.cmd`];
    } else {
      this._writeEmitter.fire('Error: set emacsTabComplete.cmHome or cmStartCommand\r\n');
      return;
    }
    this._writeEmitter.fire(`Starting CM: ${cmd} ${args.join(' ')}\r\n`);
    this._process = spawn(cmd, args, {
      cwd: cmHome || undefined,
      env: { ...process.env },
      shell: false,
    });
    this._process.stdout.on('data', (data) => this._onOutput(data.toString()));
    this._process.stderr.on('data', (data) => this._onOutput(data.toString()));
    this._process.on('close', (code) => {
      this._writeEmitter.fire(`\r\nCM process exited with code ${code}\r\n`);
      this._closeEmitter.fire(code || 0);
      this._process = null;
      this.inDebugPrompt = false;
    });
  }

  close() {
    if (this._process) { this._process.kill(); this._process = null; }
  }

  handleInput(data) {
    if (!this._process) return;
    // Ctrl+C → kill signal
    if (data === '\x03') { this._process.kill('SIGINT'); return; }
    this._process.stdin.write(data);
    this._writeEmitter.fire(data); // local echo
  }

  send(text) {
    if (!this._process) {
      vscode.window.showInformationMessage('CM process is not running. Start it with Ctrl+Alt+F5.');
      return;
    }
    this._process.stdin.write(text + '\n');
  }

  _onOutput(text) {
    // Display in the terminal
    const display = text.replace(/\n/g, '\r\n');
    this._writeEmitter.fire(display);
    this._outputBuffer += text;

    // Detect debug prompt: CM prints a stack trace then waits for input
    if (/(?:^|\n)\s*(?:cm>|debug>|\?\s*>)/m.test(this._outputBuffer) ||
        /Error.*\n.*at\s+/m.test(this._outputBuffer)) {
      this.inDebugPrompt = true;
      this._parseCurrentPosition();
    }

    // Feed output to the error parser for diagnostics (red squiggles).
    updateDiagnosticsFromOutput(this._outputBuffer);

    // If evaluating, check for our marker
    if (this._evalMarker && this._outputBuffer.includes(this._evalMarker)) {
      const startTag = `__EVAL_START_${this._evalMarker}__`;
      const endTag = `__EVAL_END_${this._evalMarker}__`;
      const si = this._outputBuffer.indexOf(startTag);
      const ei = this._outputBuffer.indexOf(endTag);
      if (si !== -1 && ei !== -1) {
        const result = this._outputBuffer.slice(si + startTag.length, ei).trim();
        if (this._evalResolve) this._evalResolve(result);
        this._evalResolve = null;
        this._evalMarker = null;
      }
    }
  }

  _parseCurrentPosition() {
    // Parse file:line from stack trace output. CM stack traces look like:
    //   at ClassName.method (file.cm:123)
    //   or similar patterns depending on the CM version
    const m = this._outputBuffer.match(/(?:at\s+\S+\s+\(|(?:^|\n)\s*)([A-Za-z]:[^\s:]+\.cm|[^\s:]+\.cm):(\d+)/m);
    if (m) {
      this.currentFile = m[1].replace(/\//g, pathMod.sep);
      this.currentLine = parseInt(m[2], 10);
      this._highlightCurrentLine();
    }
    this._outputBuffer = this._outputBuffer.slice(-2000); // keep buffer bounded
  }

  async _highlightCurrentLine() {
    if (!this.currentFile || !this.currentLine) return;
    try {
      const uri = vscode.Uri.file(this.currentFile);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = Math.max(0, this.currentLine - 1);
      const range = new vscode.Range(line, 0, line, 0);
      editor.setDecorations(this._debugHighlight, [{ range }]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(new vscode.Position(line, 0), new vscode.Position(line, 0));
    } catch {}
  }

  clearHighlight() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._debugHighlight, []);
    }
  }

  /** Evaluate an expression in the CM debug prompt and return the text result. */
  evaluate(expression, timeoutMs = 3000) {
    return new Promise((resolve) => {
      if (!this._process || !this.inDebugPrompt) { resolve('<not in debug>'); return; }
      const marker = Date.now().toString(36);
      this._evalMarker = marker;
      this._evalResolve = resolve;
      const startTag = `__EVAL_START_${marker}__`;
      const endTag = `__EVAL_END_${marker}__`;
      this.send(`pln("${startTag}"); pln(${expression}); pln("${endTag}");`);
      setTimeout(() => {
        if (this._evalResolve === resolve) { this._evalResolve = null; this._evalMarker = null; resolve('<timeout>'); }
      }, timeoutMs);
    });
  }

  // ---- Stepping ----

  /** Find the next executable line after `line` (1-based) in `filePath`. */
  _findNextLine(text, currentLine) {
    const lines = text.split(/\r?\n/);
    for (let i = currentLine; i < lines.length; i++) { // currentLine is 1-based, so index i = next line
      const trimmed = lines[i].trim();
      if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') &&
          !trimmed.startsWith('*') && trimmed !== '{' && trimmed !== '}') {
        return i + 1; // return 1-based
      }
    }
    return null;
  }

  async stepOver() {
    if (!this.currentFile || !this.currentLine) { this.send('quit();'); return; }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.currentFile));
      const nextLine = this._findNextLine(doc.getText(), this.currentLine);
      if (nextLine) {
        const offset = doc.offsetAt(new vscode.Position(nextLine - 1, 0));
        const filePath = this.currentFile.replace(/\\/g, '/');
        this.send(`inspect("${filePath}", ${offset}); quit();`);
      } else {
        this.send('quit();');
      }
    } catch { this.send('quit();'); }
    this._outputBuffer = '';
  }

  stepInto() {
    // CM doesn't have a step-into command; we use inspect at the current position
    // which effectively re-enters the next call. Best effort.
    if (!this.currentFile || !this.currentLine) { this.send('quit();'); return; }
    const filePath = this.currentFile.replace(/\\/g, '/');
    // Set inspect at current line to catch the next method entry
    this.send('quit();');
    this._outputBuffer = '';
  }

  stepOut() {
    // Resume execution — equivalent to running until the current method returns
    this.clearHighlight();
    this.inDebugPrompt = false;
    this.send('quit();');
    this._outputBuffer = '';
  }

  continue() {
    this.clearHighlight();
    this.inDebugPrompt = false;
    this.send('quit();');
    this._outputBuffer = '';
  }

  // ---- Locals ----

  async refreshLocals() {
    if (!this.currentFile || !this.currentLine || !this.inDebugPrompt) {
      this._localsData = [];
      if (this._localsProvider) this._localsProvider.refresh();
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.currentFile));
      const text = doc.getText();
      const locals = this._parseLocals(text, this.currentLine);
      const results = [];
      for (const v of locals) {
        const val = await this.evaluate(v.name);
        results.push({ name: v.name, type: v.type, value: val });
      }
      this._localsData = results;
    } catch { this._localsData = []; }
    if (this._localsProvider) this._localsProvider.refresh();
  }

  /** Parse local variable declarations in the method containing `line` (1-based). */
  _parseLocals(text, targetLine) {
    const lines = text.split(/\r?\n/);
    // Walk backward to find the method start
    let methodStart = targetLine - 1;
    let braceDepth = 0;
    for (let i = targetLine - 1; i >= 0; i--) {
      const t = lines[i].trim();
      for (const ch of t) { if (ch === '}') braceDepth++; else if (ch === '{') braceDepth--; }
      if (braceDepth < 0) { methodStart = i; break; }
    }
    // Scan from method start to current line for declarations
    const declRe = /\b([A-Z][A-Za-z_\w]*(?:\[\])?)\s+([a-z_][A-Za-z_\w]*)\s*[=;,(]/g;
    const seen = new Set();
    const locals = [];
    for (let i = methodStart; i < targetLine && i < lines.length; i++) {
      const line = lines[i];
      let m;
      declRe.lastIndex = 0;
      while ((m = declRe.exec(line)) !== null) {
        const type = m[1]; const name = m[2];
        if (!seen.has(name) && !NON_TYPE_KEYWORDS.has(type) && !NON_TYPE_KEYWORDS.has(name)) {
          seen.add(name);
          locals.push({ type, name });
        }
      }
    }
    // Also add `this` for methods inside a class
    locals.unshift({ type: 'this', name: 'this' });
    return locals;
  }

  // ---- Watches ----

  async addWatch() {
    const expr = await vscode.window.showInputBox({ prompt: 'Watch expression', placeHolder: 'this.w' });
    if (!expr) return;
    this.watches.push({ expression: expr, value: '<not evaluated>' });
    await this.refreshWatches();
  }

  removeWatch(index) {
    this.watches.splice(index, 1);
    if (this._watchProvider) this._watchProvider.refresh();
  }

  async refreshWatches() {
    if (this.inDebugPrompt) {
      for (const w of this.watches) {
        w.value = await this.evaluate(w.expression);
      }
    }
    if (this._watchProvider) this._watchProvider.refresh();
  }
}

/** TreeDataProvider for the Locals panel. */
class LocalsProvider {
  constructor() { this._onDidChange = new vscode.EventEmitter(); this.onDidChangeTreeData = this._onDidChange.event; }
  refresh() { this._onDidChange.fire(); }
  getTreeItem(el) {
    const item = new vscode.TreeItem(`${el.name}: ${el.value}`, vscode.TreeItemCollapsibleState.None);
    item.description = el.type;
    item.tooltip = `${el.type} ${el.name} = ${el.value}`;
    return item;
  }
  getChildren() {
    if (!cmDebugEngine) return [];
    return cmDebugEngine._localsData;
  }
}

/** TreeDataProvider for the Watch panel. */
class WatchProvider {
  constructor() { this._onDidChange = new vscode.EventEmitter(); this.onDidChangeTreeData = this._onDidChange.event; }
  refresh() { this._onDidChange.fire(); }
  getTreeItem(el) {
    const item = new vscode.TreeItem(`${el.expression}: ${el.value}`, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'watchItem';
    item.tooltip = el.expression;
    return item;
  }
  getChildren() {
    if (!cmDebugEngine) return [];
    return cmDebugEngine.watches.map((w, i) => ({ ...w, index: i }));
  }
}

function startCmDebug() {
  if (cmDebugEngine && cmDebugEngine._process) {
    cmDebugEngine._terminal.show();
    return;
  }
  cmDebugEngine = new CmDebugEngine();
  const localsProvider = new LocalsProvider();
  const watchProvider = new WatchProvider();
  cmDebugEngine._localsProvider = localsProvider;
  cmDebugEngine._watchProvider = watchProvider;
  const term = vscode.window.createTerminal({ name: CM_TERMINAL_NAME, pty: cmDebugEngine });
  cmDebugEngine._terminal = term;
  term.show();
  return { localsProvider, watchProvider };
}

async function cmDebugStepOver() {
  if (cmDebugEngine) { await cmDebugEngine.stepOver(); await cmDebugEngine.refreshLocals(); await cmDebugEngine.refreshWatches(); }
}
async function cmDebugStepInto() {
  if (cmDebugEngine) { await cmDebugEngine.stepInto(); await cmDebugEngine.refreshLocals(); await cmDebugEngine.refreshWatches(); }
}
async function cmDebugStepOut() {
  if (cmDebugEngine) { cmDebugEngine.stepOut(); }
}
async function cmDebugContinue() {
  if (cmDebugEngine) { cmDebugEngine.continue(); }
}
async function cmDebugAddWatch() {
  if (cmDebugEngine) { await cmDebugEngine.addWatch(); }
}
function cmDebugRemoveWatch(item) {
  if (cmDebugEngine && item && item.index !== undefined) { cmDebugEngine.removeWatch(item.index); }
}
async function cmDebugRefresh() {
  if (cmDebugEngine) { await cmDebugEngine.refreshLocals(); await cmDebugEngine.refreshWatches(); }
}

// ---------------------------------------------------------------------------
// Breakpoints — visual red-dot gutter markers on .cm files. On compile, the
// extension sends `inspect("file", offset);` for each breakpoint so the CM
// runtime pauses there (like setting a breakpoint in C++/GDB).
// ---------------------------------------------------------------------------

const breakpointDecoration = vscode.window.createTextEditorDecorationType({
  gutterIconPath: undefined, // set below after context is available
  gutterIconSize: '80%',
  isWholeLine: false,
  overviewRulerColor: 'red',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

// Map<uri.toString(), Set<lineNumber (0-based)>>
const breakpoints = new Map();

function getBreakpoints(uri) {
  const key = uri.toString();
  if (!breakpoints.has(key)) breakpoints.set(key, new Set());
  return breakpoints.get(key);
}

function refreshBreakpointDecorations(editor) {
  if (!editor || !isCmDocument(editor.document)) return;
  const lines = getBreakpoints(editor.document.uri);
  const decorations = [];
  for (const line of lines) {
    if (line >= editor.document.lineCount) continue;
    const range = new vscode.Range(line, 0, line, 0);
    decorations.push({
      range,
      renderOptions: {
        before: {
          contentText: '●',
          color: new vscode.ThemeColor('editorError.foreground'),
          fontWeight: 'bold',
          margin: '0 4px 0 0',
        },
      },
    });
  }
  editor.setDecorations(breakpointDecoration, decorations);
}

function toggleBreakpoint() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCmDocument(editor.document)) return;
  const line = editor.selection.active.line;
  const lines = getBreakpoints(editor.document.uri);
  if (lines.has(line)) lines.delete(line);
  else lines.add(line);
  refreshBreakpointDecorations(editor);
  const count = [...breakpoints.values()].reduce((s, set) => s + set.size, 0);
  vscode.window.setStatusBarMessage(`Breakpoints: ${count}`, 3000);
}

function clearAllBreakpoints() {
  breakpoints.clear();
  for (const editor of vscode.window.visibleTextEditors) refreshBreakpointDecorations(editor);
  vscode.window.setStatusBarMessage('All breakpoints cleared.', 3000);
}

/** Send inspect() for each breakpoint to the CM process before compiling. */
function sendBreakpointsAndCompile() {
  for (const [uriStr, lines] of breakpoints) {
    if (lines.size === 0) continue;
    const uri = vscode.Uri.parse(uriStr);
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uriStr
    );
    if (!doc) continue;
    const filePath = uri.fsPath.replace(/\\/g, '/');
    for (const line of lines) {
      const offset = doc.offsetAt(new vscode.Position(line, 0));
      sendToCm(`inspect("${filePath}", ${offset});`);
    }
  }
  cmSendCompile();
}

function activate(context) {
  const dotProvider = makeDotMemberProvider();
  const formatter = makeFormattingProvider();
  context.subscriptions.push(
    vscode.commands.registerCommand('emacsTabComplete.expand', expand),
    vscode.commands.registerCommand('emacsTabComplete.listMethods', listMethods),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      session = null;
      refreshSectionDecorations(ed);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === e.document) refreshSectionDecorations(ed);
    }),
    // Invalidate the caches whenever a .cm file is saved.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith('.cm')) { memberCache = null; symbolIndex = null; methodDescCache = null; }
    }),
    // CM Navigate: Go to Definition (explicit command, not a Ctrl+Click
    // provider) + class-graph browsing.
    vscode.commands.registerCommand('emacsTabComplete.goToDefinition', goToDefinition),
    // CM Runtime commands — mirrors Emacs compilation buffer interaction.
    vscode.commands.registerCommand('emacsTabComplete.startCmDev', startCmDev),
    vscode.commands.registerCommand('emacsTabComplete.resumeFromError', resumeFromError),
    vscode.commands.registerCommand('emacsTabComplete.resumeAndClear', resumeAndClear),
    vscode.commands.registerCommand('emacsTabComplete.cmCompile', cmSendCompile),
    vscode.commands.registerCommand('emacsTabComplete.cmCompileAll', cmSendCompileAll),
    vscode.commands.registerCommand('emacsTabComplete.cmCdb', cmSendCdb),
    vscode.commands.registerCommand('emacsTabComplete.cmExit', cmSendExit),
    vscode.commands.registerCommand('emacsTabComplete.cmStackTrace', cmSendStackTrace),
    vscode.commands.registerCommand('emacsTabComplete.cmStackDump', cmSendStackDump),
    vscode.commands.registerCommand('emacsTabComplete.cmInspect', cmSendInspect),
    vscode.commands.registerCommand('emacsTabComplete.cmSendCustom', cmSendCustom),
    vscode.commands.registerCommand('emacsTabComplete.cmRequestStop', cmRequestStop),
    vscode.commands.registerCommand('emacsTabComplete.toggleBreakpoint', toggleBreakpoint),
    vscode.commands.registerCommand('emacsTabComplete.clearAllBreakpoints', clearAllBreakpoints),
    vscode.commands.registerCommand('emacsTabComplete.cmCompileWithBreakpoints', sendBreakpointsAndCompile),
    vscode.window.onDidChangeActiveTextEditor((ed) => refreshBreakpointDecorations(ed)),
    // Debug engine: stepping, locals, watches
    vscode.commands.registerCommand('emacsTabComplete.startCmDebug', () => {
      const result = startCmDebug();
      if (result) {
        context.subscriptions.push(
          vscode.window.registerTreeDataProvider('cmLocals', result.localsProvider),
          vscode.window.registerTreeDataProvider('cmWatch', result.watchProvider)
        );
      }
    }),
    vscode.commands.registerCommand('emacsTabComplete.cmStepOver', cmDebugStepOver),
    vscode.commands.registerCommand('emacsTabComplete.cmStepInto', cmDebugStepInto),
    vscode.commands.registerCommand('emacsTabComplete.cmStepOut', cmDebugStepOut),
    vscode.commands.registerCommand('emacsTabComplete.cmContinue', cmDebugContinue),
    vscode.commands.registerCommand('emacsTabComplete.cmAddWatch', cmDebugAddWatch),
    vscode.commands.registerCommand('emacsTabComplete.cmRemoveWatch', cmDebugRemoveWatch),
    vscode.commands.registerCommand('emacsTabComplete.cmRefreshDebug', cmDebugRefresh),
    vscode.commands.registerCommand('emacsTabComplete.listParents', listParents),
    vscode.commands.registerCommand('emacsTabComplete.listSubclasses', listSubclasses),
    vscode.commands.registerCommand('emacsTabComplete.listClassMethods', listClassMethods),
    vscode.commands.registerCommand('emacsTabComplete.listOverrides', listOverrides),
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
    vscode.languages.registerOnTypeFormattingEditProvider(CM_SELECTOR, formatter, '}'),
    // Document symbols (Outline panel + breadcrumbs + section regions).
    vscode.languages.registerDocumentSymbolProvider(CM_SELECTOR, makeDocumentSymbolProvider()),
    // Folding ranges for section headers (collapsible regions).
    vscode.languages.registerFoldingRangeProvider(CM_SELECTOR, makeFoldingRangeProvider()),
    // Hover info (class/method signatures).
    vscode.languages.registerHoverProvider(CM_SELECTOR, makeHoverProvider()),
    // Diagnostics collection (compiler errors parsed from terminal output).
    cmDiagnostics
  );

  // Warm the navigation index in the background a few seconds after startup, so
  // the first Go to Definition / List Parents / etc. is instant instead of
  // waiting ~20s for the first scan. Silent and best-effort.
  setTimeout(() => { getSymbolIndex().catch(() => {}); }, 4000);
}

function deactivate() {
  session = null;
}

module.exports = { activate, deactivate };
