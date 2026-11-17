// Finds references to one field inside Conga Platform custom code (C# projects used by
// Service Hooks, Callbacks and Custom APIs).
//
// Platform APIs used (all read-only):
//   GET /api/extensibility/v1/customcode                          every project
//   GET /api/extensibility/v1/customcode/{name}                   project Documents [{ Name, FilePath, SourceCode }]
//   GET /api/extensibility/v1/customcode/{name}/download          ZIP fallback when Documents is empty
//   GET /api/extensibility/v1/callbacks                           callback contract -> { ProjectName, ClassName }
//   GET /api/extensibility/v1/customcode/api-resource[/{n}/uri-entries]   Custom API route -> project/class/method
//   Service Hook rules are passed in (already read by the usage scan) -> CustomCodeDetails { ProjectName, ClassName }
//
// Source is analysed as text: comments are ignored, string literals and identifiers are matched as whole tokens.
// Nothing is compiled or executed.
import { readZipTextEntries } from './zipReader.js';

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

const lower = (value) => String(value ?? '').toLowerCase();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = (value, flags = 'i') => new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(value)}(?=$|[^A-Za-z0-9_])`, flags);
const BINARY_EXTENSIONS = /\.(dll|pdb|exe|png|jpe?g|gif|ico|zip|nupkg|snk|pfx|bin)$/i;
const MAX_FILE_CHARS = 2_000_000;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// Splits C# source into code (comments blanked, string contents blanked) plus the list of string literals.
// Line breaks are preserved so offsets map back to line numbers.
export function lexCSharp(source) {
  const text = String(source ?? '');
  const code = [];
  const strings = [];
  let index = 0;
  const blank = (segment) => segment.replace(/[^\n]/g, ' ');
  while (index < text.length) {
    const char = text[index]; const next = text[index + 1];
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index); const stop = end < 0 ? text.length : end;
      code.push(blank(text.slice(index, stop))); index = stop; continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2); const stop = end < 0 ? text.length : end + 2;
      code.push(blank(text.slice(index, stop))); index = stop; continue;
    }
    // String literals: "...", @"...", $"...", $@"...", @$"...", and raw """...""".
    const prefix = text.slice(index, index + 3);
    const prefixMatch = /^(\$@|@\$|\$|@)?"/.exec(prefix);
    if (prefixMatch) {
      const start = index;
      const verbatim = (prefixMatch[1] ?? '').includes('@');
      let cursor = index + prefixMatch[0].length;
      if (text.startsWith('""', cursor) && !verbatim) {
        // raw string literal """ ... """
        const end = text.indexOf('"""', cursor + 2);
        const stop = end < 0 ? text.length : end + 3;
        strings.push({ value: text.slice(cursor + 2, end < 0 ? text.length : end), offset: start });
        code.push('"'); code.push(blank(text.slice(start + 1, stop - 1))); code.push('"'); index = stop; continue;
      }
      let value = '';
      while (cursor < text.length) {
        const current = text[cursor];
        if (verbatim && current === '"' && text[cursor + 1] === '"') { value += '"'; cursor += 2; continue; }
        if (!verbatim && current === '\\') { value += text.slice(cursor, cursor + 2); cursor += 2; continue; }
        if (current === '"') { cursor += 1; break; }
        if (!verbatim && current === '\n') break;
        value += current; cursor += 1;
      }
      strings.push({ value, offset: start });
      code.push('"'); code.push(blank(text.slice(start + 1, cursor - 1))); code.push('"');
      index = cursor; continue;
    }
    if (char === "'") {
      const match = /^'(?:\\.|[^'\\\n]){0,8}'/.exec(text.slice(index, index + 12));
      if (match) { code.push(blank(match[0])); index += match[0].length; continue; }
    }
    code.push(char); index += 1;
  }
  return { code: code.join(''), strings };
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}
function lineOf(starts, offset) {
  let low = 0; let high = starts.length - 1;
  while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= offset) low = mid; else high = mid - 1; }
  return low + 1;
}

// Class and method declarations with the line they start on, so a match can be attributed to Class.Method.
function declarations(code, starts) {
  const classes = []; const methods = [];
  for (const match of code.matchAll(/\b(?:class|record|struct|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) classes.push({ name: match[1], line: lineOf(starts, match.index) });
  const methodPattern = /^[ \t]*((?:(?:public|private|protected|internal|static|async|override|virtual|sealed|abstract|partial|new|extern|unsafe)\s+)*)([A-Za-z_][\w<>\[\],.?]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^<>()]*>)?\s*\([^;{}]*\)\s*(?:where[^{;]*)?(?:\{|=>|$)/gm;
  const notTypes = new Set(['return', 'await', 'new', 'throw', 'else', 'yield', 'var', 'using', 'case', 'goto', 'in', 'is', 'as']);
  const notNames = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'nameof', 'typeof', 'sizeof']);
  for (const match of code.matchAll(methodPattern)) {
    if (notTypes.has(match[2]) || notNames.has(match[3])) continue;
    methods.push({ name: match[3], line: lineOf(starts, match.index + match[0].length - match[0].trimStart().length) });
  }
  const namespace = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(code)?.[1] ?? null;
  return { classes, methods, namespace };
}
const enclosing = (list, line) => list.filter((item) => item.line <= line).at(-1)?.name ?? null;

const WRITE_CALL = /\b(?:Set|SetValue|SetFieldValue|SetAttribute|Add|TryAdd|Upsert|Update)[A-Za-z]*\s*(?:<[^>]*>)?\s*\(\s*$/;
const READ_CALL = /\b(?:Get|GetValue|GetFieldValue|TryGetValue|GetAttribute|ContainsKey|Contains|Remove)[A-Za-z]*\s*(?:<[^>]*>)?\s*\(\s*$/;
const PERSIST_CALL = /\b(?:Insert|Update|Upsert|Patch|Save)[A-Za-z]*Async\b|\bDictionary\s*</;
const QUERY_HINT = /(\bselect\b|\bwhere\b|\band\b|\bor\b|\bin\b\s*\(|!=|==|<=|>=|=|<|>|\bcriteria\b|\bfilter\b|\bsort)/i;

// Classifies how a line uses the field: Write, Read, Query / criteria or Reference.
function accessFor({ kind, lineText, before, after, literalValue, context }) {
  if (kind === 'literal-contains' && QUERY_HINT.test(literalValue)) return 'Query / criteria';
  if (kind === 'qualified') return QUERY_HINT.test(literalValue ?? '') ? 'Query / criteria' : 'Reference';
  const tail = after.replace(/^"/, '');
  if (kind === 'literal-exact') {
    if (/^\s*\]\s*=(?!=)/.test(tail)) return 'Write';                       // record["Field"] = value
    if (/^\s*\]/.test(tail)) return 'Read';                                 // value = record["Field"]
    if (WRITE_CALL.test(before)) return 'Write';                            // item.Set("Field", value)
    if (READ_CALL.test(before)) return 'Read';                              // item.GetValue<T>("Field")
    if (/\{\s*$/.test(before) && /^\s*,/.test(tail) && PERSIST_CALL.test(context)) return 'Write'; // { "Field", value } in an insert/update dictionary
    return 'Reference';
  }
  // identifier
  if (/^\s*(?:=(?!=)|\+=|-=|\*=|\/=|\?\?=)/.test(after)) return 'Write';    // record.Field = value / Field = value in an initializer
  if (/\bnameof\s*\(\s*[A-Za-z0-9_.]*$/.test(before)) return 'Reference';
  if (/\b(?:public|private|protected|internal)\b[^=();]*$/.test(before) && /^\s*(?:\{|=>|;)/.test(after)) return 'Declaration';
  return lineText.trim() ? 'Read' : 'Reference';
}

function snippetFor(lines, line) {
  return String(lines[line - 1] ?? '').trim().slice(0, 300);
}

// Scans one source file. `context` says whether the selected object is evident from the file, the project
// or the way the project is wired (e.g. a Service Hook on the selected object).
export function findFieldInSource(source, objectName, fieldName, { projectHasObject = false, wiredToObject = false } = {}) {
  const text = String(source ?? '');
  if (!text || text.length > MAX_FILE_CHARS) return { matches: [], fileHasObject: false };
  const lowerText = text.toLowerCase();
  if (!lowerText.includes(lower(fieldName))) return { matches: [], fileHasObject: wordPattern(objectName).test(text) };
  const { code, strings } = lexCSharp(text);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const decl = declarations(code, starts);
  const qualified = wordPattern(`${objectName}.${fieldName}`);
  const bare = wordPattern(fieldName);
  const objectToken = wordPattern(objectName);
  const fileHasObject = objectToken.test(code) || strings.some((item) => objectToken.test(item.value));
  const hasContext = fileHasObject || projectHasObject || wiredToObject;
  const raw = [];

  for (const literal of strings) {
    const value = literal.value;
    let kind = null;
    if (qualified.test(value)) kind = 'qualified';
    else if (lower(value.trim()) === lower(fieldName)) kind = 'literal-exact';
    else if (bare.test(value)) kind = 'literal-contains';
    if (!kind) continue;
    let confidence;
    if (kind === 'qualified') confidence = 'Exact';
    else if (kind === 'literal-exact') confidence = (fileHasObject || wiredToObject) ? 'Exact' : projectHasObject ? 'Probable' : 'Possible';
    else confidence = hasContext ? 'Probable' : 'Possible';
    raw.push({ kind, offset: literal.offset, length: value.length + 2, confidence, literalValue: value });
  }

  if (hasContext) {
    const identifier = new RegExp(`(^|[^A-Za-z0-9_"])(${escapeRegex(fieldName)})(?=$|[^A-Za-z0-9_"])`, 'g');
    for (const match of code.matchAll(identifier)) {
      const offset = match.index + match[1].length;
      const before = code.slice(Math.max(0, offset - 40), offset);
      if (/\b(?:class|namespace|using)\s+[A-Za-z0-9_.]*$/.test(before)) continue;
      raw.push({ kind: 'identifier', offset, length: fieldName.length, confidence: 'Probable' });
    }
  }

  const seen = new Set();
  const matches = [];
  for (const item of raw.sort((left, right) => left.offset - right.offset)) {
    const line = lineOf(starts, item.offset);
    const lineStart = starts[line - 1];
    const lineText = lines[line - 1] ?? '';
    const before = text.slice(lineStart, item.offset);
    const after = text.slice(item.offset + (item.kind === 'identifier' ? item.length : 0), lineStart + lineText.length + 1)
      .replace(item.kind === 'identifier' ? /^/ : /^(\$@|@\$|\$|@)?"(?:[^"\\]|\\.|"")*"?/, '');
    const context = lines.slice(Math.max(0, line - 4), line + 1).join('\n');
    const access = accessFor({ kind: item.kind, lineText, before, after, literalValue: item.literalValue, context });
    const key = `${line}|${access}`;
    if (seen.has(key)) {
      const existing = matches.find((match) => match.line === line && match.access === access);
      const rank = { Exact: 3, Probable: 2, Possible: 1 };
      if (existing && rank[item.confidence] > rank[existing.confidence]) existing.confidence = item.confidence;
      continue;
    }
    seen.add(key);
    matches.push({
      line,
      className: enclosing(decl.classes, line),
      methodName: enclosing(decl.methods, line),
      namespace: decl.namespace,
      access,
      confidence: item.confidence,
      matchKind: item.kind,
      snippet: snippetFor(lines, line)
    });
  }
  return { matches, fileHasObject };
}

const shortClass = (name) => lower(String(name ?? '').split('.').at(-1));

// Index of how each project/class is executed: Service Hook, Callback or Custom API.
function buildWiring(hooks, callbacks, apiRoutes) {
  const byProject = new Map();
  const add = (projectName, className, entry) => {
    if (!projectName) return;
    const key = lower(projectName);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push({ className: className ? shortClass(className) : null, ...entry });
  };
  for (const hook of hooks ?? []) {
    const details = pick(hook, 'CustomCodeDetails', 'customCodeDetails') ?? {};
    add(pick(details, 'ProjectName', 'projectName'), pick(details, 'ClassName', 'className'), {
      type: 'Service Hook',
      name: pick(hook, 'Name', 'name') ?? 'Service Hook',
      objectName: pick(hook, 'ObjectName', 'objectName') ?? null,
      detail: [pick(hook, 'RuleType', 'ruleType'), (pick(hook, 'EventTypes', 'eventTypes') ?? []).join('/')].filter(Boolean).join(' · '),
      active: pick(hook, 'IsActive', 'isActive') !== false
    });
  }
  for (const contract of callbacks ?? []) {
    const mapping = pick(contract, 'CustomCodeMapping', 'customCodeMapping') ?? {};
    add(pick(mapping, 'ProjectName', 'projectName'), pick(mapping, 'ClassName', 'className'), {
      type: 'Callback',
      name: pick(contract, 'CallbackDisplayName', 'CallbackShortName', 'CallbackName') ?? 'Callback',
      objectName: null,
      detail: pick(contract, 'CallbackCategoryName', 'callbackCategoryName') ?? '',
      active: true
    });
  }
  for (const route of apiRoutes ?? []) {
    const verb = String(pick(route, 'HttpVerb', 'httpVerb') ?? route.defaultVerb ?? '').toUpperCase();
    add(pick(route, 'CustomCodeName', 'customCodeName'), pick(route, 'FullyQualifiedClassName', 'fullyQualifiedClassName'), {
      type: 'Custom API',
      name: `${verb ? `${verb} ` : ''}/api/custom-api/v1/${route.resourceName}${pick(route, 'Route', 'route') ?? ''}`,
      objectName: null,
      detail: pick(route, 'MethodName', 'methodName') ?? '',
      methodName: pick(route, 'MethodName', 'methodName') ?? null,
      active: true
    });
  }
  return byProject;
}

async function projectDocuments(client, summary) {
  const name = String(pick(summary, 'Name', 'name') ?? '');
  let project = summary;
  let documents = pick(summary, 'Documents', 'documents');
  if (!Array.isArray(documents) || !documents.some((doc) => typeof pick(doc, 'SourceCode', 'sourceCode') === 'string')) {
    project = await client.getCustomCodeProject(name);
    documents = pick(project, 'Documents', 'documents');
  }
  let source = 'Project API';
  let files = (Array.isArray(documents) ? documents : [])
    .map((doc) => ({ path: String(pick(doc, 'FilePath', 'filePath') || pick(doc, 'Name', 'name') || 'unnamed'), text: pick(doc, 'SourceCode', 'sourceCode') }))
    .filter((doc) => typeof doc.text === 'string');
  if (!files.length) {
    const zip = await client.downloadCustomCodeProject(name);
    files = readZipTextEntries(zip, (path) => !BINARY_EXTENSIONS.test(path) && !/(^|\/)(bin|obj)\//i.test(path));
    source = 'Project download';
  }
  return { name, project, files, source };
}

export async function scanCustomCode(client, objectName, fieldName, { hooks = [] } = {}) {
  const projects = await client.listCustomCodeProjects();
  const notes = [];
  const [callbacks, apiRoutes] = await Promise.all([
    client.listCallbackContracts().catch((error) => { notes.push(`Callback mappings could not be read (${error.message}); "Runs as" may omit callbacks.`); return []; }),
    client.listCustomApiRoutes().catch((error) => { notes.push(`Custom API routes could not be read (${error.message}); "Runs as" may omit Custom APIs.`); return []; })
  ]);
  const wiring = buildWiring(hooks, callbacks, apiRoutes);
  const failures = [];
  let filesScanned = 0; let linesScanned = 0;

  const perProject = await mapWithConcurrency(projects, 3, async (summary) => {
    const summaryName = String(pick(summary, 'Name', 'name') ?? '');
    if (!summaryName) return [];
    try {
      const { name, project, files, source } = await projectDocuments(client, summary);
      filesScanned += files.length;
      linesScanned += files.reduce((sum, file) => sum + file.text.split('\n').length, 0);
      const projectWiring = wiring.get(lower(name)) ?? [];
      const projectHasObject = files.some((file) => wordPattern(objectName).test(file.text));
      const results = [];
      for (const file of files) {
        const fileClasses = [...String(file.text).matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => lower(match[1]));
        const fileWiring = projectWiring.filter((entry) => !entry.className || fileClasses.includes(entry.className));
        const wiredToObject = fileWiring.some((entry) => lower(entry.objectName) === lower(objectName));
        const { matches } = findFieldInSource(file.text, objectName, fieldName, { projectHasObject, wiredToObject });
        for (const match of matches) {
          const runsAs = projectWiring.filter((entry) => !entry.className || entry.className === lower(match.className));
          results.push({
            id: `custom-code:${name}:${file.path}:${match.line}:${match.access}`,
            recordId: name,
            projectName: name,
            projectStatus: pick(project, 'Status', 'status') ?? null,
            projectVersion: pick(project, 'Version', 'version') ?? null,
            filePath: file.path,
            source,
            ...match,
            runsAs: runsAs.map(({ type, name: runName, objectName: runObject, detail, active }) => ({ type, name: runName, objectName: runObject, detail, active }))
          });
        }
      }
      return results;
    } catch (error) {
      failures.push(`${summaryName} (${error.message})`);
      return [];
    }
  });

  const rank = { Exact: 0, Probable: 1, Possible: 2 };
  const results = perProject.flat().sort((left, right) => rank[left.confidence] - rank[right.confidence] ||
    left.projectName.localeCompare(right.projectName) || left.filePath.localeCompare(right.filePath) || left.line - right.line);
  return { results, projectsScanned: projects.length, filesScanned, linesScanned, failures, notes, callbacksMapped: callbacks.length, customApiRoutes: apiRoutes.length };
}
