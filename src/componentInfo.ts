import * as fs from 'fs';
import * as path from 'path';
import { camelize, positionInText } from './lib';

// ─────────────────────────────────────────────────────────────────────────────
// Component hover core: parse the public API of a local SFC component
// (defineProps / withDefaults / defineEmits / defineModel / defineExpose)
// and resolve component tags in a template to imported .vue files.
//
// Textual parsing (no TS AST): the macros live in `<script setup>` and are
// plain calls; for hover display a faithful-but-lossless rendering is enough.
// Pure functions only — no vscode API — fully covered by vitest.
// ─────────────────────────────────────────────────────────────────────────────

export interface PropInfo {
    name: string;
    type: string;
    required: boolean;
    default: string | null;
    doc: string | null;
}

export interface EmitInfo {
    name: string;
    /** e.g. "(value: string)" — empty string when the emit has no payload */
    params: string;
    doc: string | null;
}

export interface ModelInfo {
    name: string;
    type: string;
    required: boolean;
}

export interface ExposeInfo {
    name: string;
    /** e.g. "()" for a callable, "" for a plain value */
    signature: string;
}

export interface ComponentApi {
    description: string | null;
    props: PropInfo[];
    emits: EmitInfo[];
    models: ModelInfo[];
    expose: ExposeInfo[];
}

export interface ResolvedComponent {
    /** PascalCase local import name, e.g. "ProductCard" */
    name: string;
    /** raw import specifier, e.g. "@/modules/catalog/components/ProductCard.vue" */
    source: string;
    /** resolved absolute path; null when the specifier does not resolve to a local .vue */
    file: string | null;
    api: ComponentApi | null;
    tagStart: number;
    tagEnd: number;
}

const EMPTY_API: ComponentApi = { description: null, props: [], emits: [], models: [], expose: [] };

export function pascalize(s: string): string {
    const c = camelize(s);
    return c.charAt(0).toUpperCase() + c.slice(1);
}

export function collapseSpace(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * String-aware JSONC comment stripping: `paths` values themselves contain
 * the comment-opener sequence (`"@/*"`, `"./resources/js/*"`) — a plain
 * regex would treat it as a comment start and eat code up to the next
 * comment close, breaking the JSON.
 */
export function stripComments(text: string): string {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i] ?? '';
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < text.length) {
                out += text[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === '"') {
                inString = false;
            }
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                i++;
            }
            i = i + 1 < text.length ? i + 2 : text.length;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function stripTrailingCommas(json: string): string {
    return json.replace(/,(\s*[}\]])/g, '$1');
}

// ── JSDoc on type-literal members ───────────────────────────────────────────

function cleanDoc(raw: string): string {
    return raw
        .split('\n')
        .map((l) => l.replace(/^\s*\*? ?/, '').trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// NUL-wrapped index token keeps a doc glued to its member through splitting.
const DOC_TOKEN = '\u0000';
const DOC_TOKEN_RE = /\u0000(\d+)\u0000/g;

function tokenizeDocComments(body: string): { text: string; docs: string[] } {
    const docs: string[] = [];
    let text = '';
    let copied = 0;
    let i = 0;
    while (i < body.length) {
        const c = body[i] ?? '';
        if (c === '"') {
            i++;
            while (i < body.length && body[i] !== '"') {
                if (body[i] === '\\') {
                    i++;
                }
                i++;
            }
            i++;
            continue;
        }
        if (c === '/' && body[i + 1] === '*') {
            let j = i + 2;
            while (j + 1 < body.length && !(body[j] === '*' && body[j + 1] === '/')) {
                j++;
            }
            const end = j + 1 < body.length ? j + 2 : body.length;
            text += body.slice(copied, i);
            text += `${DOC_TOKEN}${docs.length}${DOC_TOKEN}`;
            docs.push(cleanDoc(body.slice(i + 2, end - 2)));
            copied = end;
            i = end;
            continue;
        }
        i++;
    }
    text += body.slice(copied);
    return { text, docs };
}

function stripDocTokens(part: string, docs: string[]): { text: string; tokens: string[] } {
    const tokens: string[] = [];
    const text = part
        .replace(DOC_TOKEN_RE, (_m, n: string) => {
            tokens.push(docs[Number(n)] ?? '');
            return '';
        })
        .trim();
    return { text, tokens };
}

interface MemberWithDoc {
    member: string;
    doc: string | null;
}

function membersWithDocs(body: string): MemberWithDoc[] {
    const { text, docs } = tokenizeDocComments(body);
    const out: MemberWithDoc[] = [];
    let pending: string[] = [];
    for (const part of splitTopLevel(text, ';\n')) {
        const stripped = stripDocTokens(part, docs);
        if (!stripped.text) {
            pending.push(...stripped.tokens);
            continue;
        }
        const docParts = [...pending, ...stripped.tokens].filter((d) => d.length > 0);
        out.push({ member: stripped.text, doc: docParts.length ? docParts.join(' ') : null });
        pending = [];
    }
    return out;
}

/** JSDoc block immediately preceding offset `start` (whitespace between allowed). */
function docBefore(code: string, start: number): string | null {
    let i = start;
    while (i > 0 && /\s/.test(code[i - 1] ?? '')) {
        i--;
    }
    if (!code.slice(Math.max(0, i - 2), i).endsWith('*/')) {
        return null;
    }
    const open = code.lastIndexOf('/**', i - 2);
    if (open === -1) {
        return null;
    }
    const raw = code.slice(open + 3, i - 2);
    if (raw.includes('*/')) {
        return null;
    }
    const cleaned = cleanDoc(raw);
    return cleaned.length > 0 ? cleaned : null;
}

// ── top-level splitting ─────────────────────────────────────────────────────

/**
 * Split `text` by any char in `seps` that appears at nesting depth 0
 * (parens/brackets/braces tracked; string literals skipped).
 */
export function splitTopLevel(text: string, seps: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i] ?? '';
        if (quote !== null) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            quote = c;
        } else if ('([{'.includes(c)) {
            depth++;
        } else if (')]}'.includes(c)) {
            depth--;
        } else if (depth === 0 && seps.includes(c)) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Content between the bracket at `openIdx` and its match; null when unbalanced. */
export function extractBracketBlock(text: string, openIdx: number): string | null {
    const open = text[openIdx] ?? '';
    const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : '';
    if (!close) {
        return null;
    }
    let depth = 0;
    let quote: string | null = null;
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (quote !== null) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            quote = c;
        } else if (c === open) {
            depth++;
        } else if (c === close) {
            depth--;
            if (depth === 0) {
                return text.slice(openIdx + 1, i);
            }
        }
    }
    return null;
}

/**
 * Content between `<` at `openIdx` and its matching `>` for type-argument
 * blocks. Comparison/arrow chars (`<=`, `>=`, `=>`, `<<`, `>>`) are ignored.
 */
export function extractAngleBlock(text: string, openIdx: number): string | null {
    let depth = 0;
    let quote: string | null = null;
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (quote !== null) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            quote = c;
        } else if (c === '<' && !'=<>'.includes(text[i - 1] ?? '')) {
            depth++;
        } else if (c === '>' && !'=<>'.includes(text[i - 1] ?? '')) {
            depth--;
            if (depth === 0) {
                return text.slice(openIdx + 1, i);
            }
        }
    }
    return null;
}

// ── macro call extraction ───────────────────────────────────────────────────

export interface MacroCall {
    /** offset of the macro name in the source */
    start: number;
    /** type-argument block content, e.g. "{ text: string }" — null when absent */
    generic: string | null;
    /** top-level call arguments (raw text, trimmed) */
    args: string[];
}

function findMacroCalls(code: string, name: string): MacroCall[] {
    const calls: MacroCall[] = [];
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
        let i = m.index + m[0].length;
        while (i < code.length && /\s/.test(code[i] ?? '')) {
            i++;
        }
        let generic: string | null = null;
        if (code[i] === '<') {
            generic = extractAngleBlock(code, i);
            if (generic === null) {
                continue;
            }
            i += generic.length + 2;
            while (i < code.length && /\s/.test(code[i] ?? '')) {
                i++;
            }
        }
        if (code[i] !== '(') {
            continue;
        }
        const inner = extractBracketBlock(code, i);
        if (inner === null) {
            continue;
        }
        calls.push({ start: m.index, generic, args: splitTopLevel(inner, ',') });
    }
    return calls;
}

// ── defineProps / withDefaults ──────────────────────────────────────────────

const RUNTIME_TYPE_MAP: Record<string, string> = {
    String: 'string',
    Number: 'number',
    Boolean: 'boolean',
    Object: 'object',
    Array: 'array',
    Function: 'function',
    Date: 'date',
};

function parsePropsMembers(body: string): PropInfo[] {
    const props: PropInfo[] = [];
    for (const { member, doc } of membersWithDocs(body)) {
        const m = member.match(/^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*([\s\S]+)$/);
        if (!m || m[1] === undefined) {
            continue;
        }
        props.push({
            name: m[1],
            type: collapseSpace(m[3] ?? ''),
            required: m[2] === undefined,
            default: null,
            doc,
        });
    }
    return props;
}

function parseRuntimePropsObject(objBody: string): PropInfo[] {
    const props: PropInfo[] = [];
    for (const entry of splitTopLevel(objBody, ',')) {
        const m = entry.match(/^([\w$]+)\s*:\s*([\s\S]+)$/);
        if (!m || m[1] === undefined) {
            continue;
        }
        const value = collapseSpace(m[2] ?? '');
        let type = '—';
        let required = false;
        const simple = value.match(/^[A-Za-z]+$/);
        if (simple && RUNTIME_TYPE_MAP[value] !== undefined) {
            type = RUNTIME_TYPE_MAP[value] ?? '—';
        } else {
            const t = value.match(/\btype\s*:\s*([A-Za-z]+)/);
            if (t && RUNTIME_TYPE_MAP[t[1] ?? ''] !== undefined) {
                type = RUNTIME_TYPE_MAP[t[1] ?? ''] ?? '—';
            }
            required = /\brequired\s*:\s*true\b/.test(value);
        }
        props.push({ name: m[1], type, required, default: null, doc: null });
    }
    return props;
}

function parseDefaultsObject(objBody: string): Map<string, string> {
    const defaults = new Map<string, string>();
    for (const entry of splitTopLevel(objBody, ',')) {
        const m = entry.match(/^([\w$]+)\s*:\s*([\s\S]+)$/);
        if (m && m[1] !== undefined) {
            defaults.set(m[1], collapseSpace(m[2] ?? ''));
        }
    }
    return defaults;
}

function applyDefaults(props: PropInfo[], defaults: Map<string, string>): PropInfo[] {
    for (const p of props) {
        const d = defaults.get(p.name);
        if (d !== undefined) {
            p.default = d;
        }
    }
    // A default makes a prop effectively optional in practice.
    return props.map((p) => (p.default !== null ? { ...p, required: false } : p));
}

// ── defineEmits ─────────────────────────────────────────────────────────────

function parseEmitsFromTypeLiteral(body: string): EmitInfo[] {
    const emits: EmitInfo[] = [];
    for (const { member, doc } of membersWithDocs(body)) {
        if (member.startsWith('(')) {
            // Classic call-signature form: (e: 'save', id: number): void
            const inner = member.match(/^\(([\s\S]*?)\)/);
            if (!inner || inner[1] === undefined) {
                continue;
            }
            const params = splitTopLevel(inner[1], ',');
            const first = params[0] ?? '';
            const nameMatch = first.match(/^(?:e|event)?\s*:\s*['"]([^'"]+)['"]$/);
            if (!nameMatch || nameMatch[1] === undefined) {
                continue;
            }
            const rest = params.slice(1).join(', ');
            emits.push({ name: nameMatch[1], params: rest ? `(${rest})` : '', doc });
            continue;
        }
        // Object form (Vue 3.3+): change: (value: string) => void | save: [id: number]
        const fn = member.match(/^([\w$]+)\s*:\s*\(([\s\S]*?)\)\s*=>/);
        if (fn && fn[1] !== undefined) {
            emits.push({ name: fn[1], params: (fn[2] ?? '').trim() ? `(${collapseSpace(fn[2] ?? '')})` : '', doc });
            continue;
        }
        const tuple = member.match(/^([\w$]+)\s*:\s*\[([\s\S]*?)\]$/);
        if (tuple && tuple[1] !== undefined) {
            emits.push({ name: tuple[1], params: `(${collapseSpace(tuple[2] ?? '')})`, doc });
            continue;
        }
    }
    return emits;
}

function parseEmitsFromArray(arg: string): EmitInfo[] {
    const names = [...arg.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    return names.map((name) => ({ name, params: '', doc: null }));
}

// ── defineModel ─────────────────────────────────────────────────────────────

function parseModels(calls: MacroCall[]): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const call of calls) {
        const nameArg = call.args[0] ?? '';
        const nameMatch = nameArg.match(/^['"]([^'"]+)['"]$/);
        const name = nameMatch?.[1] ?? 'modelValue';
        const opts = call.args.find((a) => a.startsWith('{')) ?? null;
        let type = call.generic !== null ? collapseSpace(call.generic) : '—';
        let required = false;
        if (opts !== null) {
            const t = opts.match(/\btype\s*:\s*([A-Za-z]+)/);
            if (t && RUNTIME_TYPE_MAP[t[1] ?? ''] !== undefined) {
                type = RUNTIME_TYPE_MAP[t[1] ?? ''] ?? type;
            }
            required = /\brequired\s*:\s*true\b/.test(opts);
        }
        models.push({ name, type, required });
    }
    return models;
}

// ── defineExpose ────────────────────────────────────────────────────────────

function parseExpose(arg: string): ExposeInfo[] {
    const objBody = arg.startsWith('{') ? extractBracketBlock(arg, 0) : null;
    if (objBody === null) {
        return [];
    }
    const expose: ExposeInfo[] = [];
    for (const entry of splitTopLevel(objBody, ',')) {
        // Method / arrow shorthand: focus() {}, focus: () => {}, focus: function () {}
        const fn = entry.match(
            /^(?:async\s+)?([\w$]+)\s*(?:\(([\s\S]*?)\)\s*(?:=>|\{)|:\s*(?:async\s+)?(?:function\s*)?\(([\s\S]*?)\))/
        );
        if (fn && fn[1] !== undefined) {
            const params = collapseSpace(fn[2] ?? fn[3] ?? '');
            expose.push({ name: fn[1], signature: `(${params})` });
            continue;
        }
        const simple = entry.match(/^([\w$]+)$/);
        if (simple && simple[1] !== undefined) {
            expose.push({ name: simple[1], signature: '' });
            continue;
        }
        const kv = entry.match(/^([\w$]+)\s*:\s*([\s\S]+)$/);
        if (kv && kv[1] !== undefined) {
            expose.push({ name: kv[1], signature: '' });
        }
    }
    return expose;
}

// ── SFC-level parsing ───────────────────────────────────────────────────────

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

export function collectScriptBlocks(sfcText: string): string[] {
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((m = SCRIPT_BLOCK_RE.exec(sfcText)) !== null) {
        if (m[1] !== undefined) {
            blocks.push(m[1]);
        }
    }
    return blocks;
}

function getSetupBlock(sfcText: string): string | null {
    const re = /<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/i;
    const m = re.exec(sfcText);
    return m && m[1] !== undefined ? m[1] : null;
}

/** Map of local import name → module specifier, from all `<script>` blocks. */
export function parseScriptImports(sfcText: string): Map<string, string> {
    const imports = new Map<string, string>();
    for (const code of collectScriptBlocks(sfcText)) {
        const defaultRe = /\bimport\s+(?:type\s+)?([\w$]+)\s*(?:,\s*\{([^}]*)\}\s*)?from\s*['"]([^'"\n]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = defaultRe.exec(code)) !== null) {
            if (m[1] !== undefined && m[3] !== undefined) {
                imports.set(m[1], m[3]);
            }
            if (m[2] !== undefined && m[3] !== undefined) {
                addNamedImports(imports, m[2], m[3]);
            }
        }
        const namedRe = /\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]/g;
        while ((m = namedRe.exec(code)) !== null) {
            if (m[1] !== undefined && m[2] !== undefined) {
                addNamedImports(imports, m[1], m[2]);
            }
        }
    }
    return imports;
}

function addNamedImports(imports: Map<string, string>, namesBlock: string, source: string): void {
    for (const entry of namesBlock.split(',')) {
        const trimmed = entry.trim().replace(/^type\s+/, '');
        const asMatch = trimmed.match(/^[\w$]+\s+as\s+([\w$]+)$/);
        if (asMatch && asMatch[1] !== undefined) {
            imports.set(asMatch[1], source);
            continue;
        }
        if (/^[\w$]+$/.test(trimmed)) {
            imports.set(trimmed, source);
        }
    }
}

/**
 * Top-level `<template>` regions `[start, end)` of the SFC — inner
 * `<template>` slots are counted, so regions never overlap.
 */
export function templateRegions(sfcText: string): Array<[number, number]> {
    const regions: Array<[number, number]> = [];
    const openRe = /<template\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(sfcText)) !== null) {
        const contentStart = m.index + m[0].length;
        const tagRe = /<(\/?)template\b[^>]*>/gi;
        tagRe.lastIndex = contentStart;
        let depth = 1;
        let c: RegExpExecArray | null;
        while ((c = tagRe.exec(sfcText)) !== null) {
            depth += (c[1] ?? '') === '/' ? -1 : 1;
            if (depth === 0) {
                regions.push([contentStart, c.index]);
                openRe.lastIndex = tagRe.lastIndex;
                break;
            }
        }
        if (depth !== 0) {
            break;
        }
    }
    return regions;
}

export interface ComponentTagHit {
    /** local import name (PascalCase) */
    name: string;
    source: string;
    start: number;
    end: number;
}

/**
 * If `offset` sits on a component tag name inside a `<template>` region and
 * the tag matches a local import — return the hit, else null.
 */
export function findComponentTagAt(
    sfcText: string,
    offset: number,
    imports: Map<string, string>,
): ComponentTagHit | null {
    for (const [start, end] of templateRegions(sfcText)) {
        const tagRe = /<\/?\s*([A-Za-z][\w.-]*)/g;
        tagRe.lastIndex = start;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(sfcText)) !== null) {
            if (m.index >= end) {
                break;
            }
            const name = m[1] ?? '';
            const nameStart = m.index + m[0].length - name.length;
            const nameEnd = nameStart + name.length;
            if (offset < nameStart || offset > nameEnd) {
                continue;
            }
            const pascal = pascalize(name);
            const source = imports.get(pascal);
            if (source !== undefined) {
                return { name: pascal, source, start: nameStart, end: nameEnd };
            }
            return null;
        }
    }
    return null;
}

// ── tsconfig alias resolution ───────────────────────────────────────────────

interface AliasEntry {
    /** e.g. "@/" for "@/*" keys, "@" for exact keys */
    prefix: string;
    /** absolute mapped prefixes, WITHOUT the trailing "/*" */
    targets: string[];
}

const tsconfigCache = new Map<string, { mtimeMs: number; aliases: AliasEntry[] }>();

function parseTsconfigAliases(absPath: string): AliasEntry[] {
    const stat = fs.statSync(absPath);
    const cached = tsconfigCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.aliases;
    }
    let aliases: AliasEntry[] = [];
    try {
        const raw = fs.readFileSync(absPath, 'utf8');
        const json = JSON.parse(stripTrailingCommas(stripComments(raw))) as {
            compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
        };
        const baseUrl = json.compilerOptions?.baseUrl
            ? path.resolve(path.dirname(absPath), json.compilerOptions.baseUrl)
            : path.dirname(absPath);
        const paths = json.compilerOptions?.paths ?? {};
        for (const [key, targets] of Object.entries(paths)) {
            if (!Array.isArray(targets)) {
                continue;
            }
            if (key.endsWith('/*')) {
                aliases.push({
                    prefix: key.slice(0, -1),
                    targets: targets.map((t) => path.resolve(baseUrl, t.endsWith('/*') ? t.slice(0, -1) : t)),
                });
            } else {
                aliases.push({
                    prefix: key,
                    targets: targets.map((t) => path.resolve(baseUrl, t)),
                });
            }
        }
    } catch {
        aliases = [];
    }
    tsconfigCache.set(absPath, { mtimeMs: stat.mtimeMs, aliases });
    return aliases;
}

/** Nearest tsconfig.json walking up from `startDir`, stopping at `workspaceRoot`. */
function loadAliases(startDir: string, workspaceRoot: string): AliasEntry[] {
    let dir = startDir;
    const root = path.parse(startDir).root;
    for (;;) {
        const ts = path.join(dir, 'tsconfig.json');
        if (fs.existsSync(ts)) {
            return parseTsconfigAliases(ts);
        }
        if (dir === workspaceRoot || dir === root) {
            return [];
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return [];
        }
        dir = parent;
    }
}

const aliasCache = new Map<string, AliasEntry[]>();

function aliasesFor(startDir: string, workspaceRoot: string): AliasEntry[] {
    const key = `${startDir}::${workspaceRoot}`;
    let cached = aliasCache.get(key);
    if (!cached) {
        cached = loadAliases(startDir, workspaceRoot);
        aliasCache.set(key, cached);
    }
    return cached;
}

/**
 * Resolve an import specifier to a local file with one of `extensions`.
 * Relative, root-absolute and alias (`@/…`) specifiers; bare package names
 * return null (library symbols are covered by Volar itself). Extension-less
 * specifiers probe `<ext>` and `<dir>/index<ext>` for every extension.
 */
export function resolveModuleImport(
    source: string,
    fromFile: string,
    workspaceRoot: string,
    extensions: readonly string[],
): string | null {
    const base = source.startsWith('/')
        ? workspaceRoot
        : source.startsWith('./') || source.startsWith('../')
          ? path.dirname(fromFile)
          : null;
    let candidates: string[] = [];
    if (base !== null) {
        candidates = [path.resolve(base, source)];
    } else {
        const aliases = aliasesFor(path.dirname(fromFile), workspaceRoot)
            .slice()
            .sort((a, b) => b.prefix.length - a.prefix.length);
        for (const entry of aliases) {
            if (source === entry.prefix) {
                candidates.push(...entry.targets);
            } else if (entry.prefix.endsWith('/') && source.startsWith(entry.prefix)) {
                const suffix = source.slice(entry.prefix.length);
                candidates.push(...entry.targets.map((t) => path.join(t, suffix)));
            }
        }
    }
    for (const cand of candidates) {
        const probes = [
            cand,
            ...extensions.map((e) => `${cand}${e}`),
            ...extensions.map((e) => path.join(cand, `index${e}`)),
        ];
        for (const probe of probes) {
            if (
                extensions.some((e) => probe.endsWith(e)) &&
                fs.existsSync(probe) &&
                fs.statSync(probe).isFile()
            ) {
                return probe;
            }
        }
    }
    return null;
}

/**
 * Resolve a component import specifier to a local .vue file.
 * Relative and alias (`@/…`) specifiers only — bare package names return null
 * (library components are covered by Volar itself).
 */
export function resolveVueImport(
    source: string,
    fromFile: string,
    workspaceRoot: string,
): string | null {
    return resolveModuleImport(source, fromFile, workspaceRoot, ['.vue']);
}

// ── type identifiers & declarations ─────────────────────────────────────────

/** Type tokens that never get a link: primitives, runtime names, TS utils. */
const NON_LINKABLE_TYPES = new Set([
    'string', 'number', 'boolean', 'object', 'any', 'unknown', 'never', 'void',
    'null', 'undefined', 'symbol', 'bigint', 'array', 'function', 'date',
    'Array', 'ReadonlyArray', 'Record', 'Readonly', 'Partial', 'Required',
    'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType',
    'Parameters', 'InstanceType', 'Awaited', 'Promise',
]);

/**
 * Linkable identifiers inside a type string. Generic/union/array wrappers
 * flatten naturally (`Array<Tag>`, `Record<string, Tag>` → `Tag`); duplicates
 * and non-linkable tokens are dropped.
 */
export function extractTypeIdentifiers(typeText: string): string[] {
    const withoutLiterals = typeText.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
    const found: string[] = [];
    for (const m of withoutLiterals.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const name = m[0];
        if (name === undefined || NON_LINKABLE_TYPES.has(name) || found.includes(name)) {
            continue;
        }
        found.push(name);
    }
    return found;
}

/** Offset of the `interface|type|class|enum NAME` keyword in `code`, null when absent. */
export function findTypeDeclaration(code: string, name: string): number | null {
    const safe = name.replace(/\$/g, '\\$');
    const m = new RegExp(`\\b(?:interface|type|class|enum)\\s+${safe}(?![\\w$])`).exec(code);
    return m === null ? null : m.index;
}

// ── type links for hover cards ──────────────────────────────────────────────

/** Extensions probed when resolving an imported type's source file. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.vue'];

export interface TypeLink {
    /** absolute file containing the declaration */
    file: string;
    /** 0-based position of the declaration keyword */
    line: number;
    character: number;
}

/** name → declaration site; null = identifier seen but unresolvable. */
export type TypeLinkIndex = Map<string, TypeLink | null>;

function readTextSafe(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function declarationLink(file: string, raw: string, name: string): TypeLink | null {
    const offset = findTypeDeclaration(raw, name);
    if (offset === null) {
        return null;
    }
    const p = positionInText(raw, offset);
    return { file, line: p.line, character: p.character };
}

function resolveTypeLink(
    name: string,
    componentFile: string,
    workspaceRoot: string,
    imports: Map<string, string>,
    componentRaw: string,
): TypeLink | null {
    const specifier = imports.get(name);
    if (specifier === undefined) {
        return declarationLink(componentFile, componentRaw, name);
    }
    const file = resolveModuleImport(specifier, componentFile, workspaceRoot, MODULE_EXTENSIONS);
    if (file === null) {
        return null;
    }
    const raw = readTextSafe(file);
    return raw === null ? null : declarationLink(file, raw, name);
}

function apiTypeTexts(api: ComponentApi | null): string[] {
    if (api === null) {
        return [];
    }
    const texts: string[] = [];
    for (const p of api.props) {
        texts.push(p.type);
    }
    for (const e of api.emits) {
        texts.push(e.params);
    }
    for (const m of api.models) {
        texts.push(m.type);
    }
    return texts;
}

/**
 * Resolve every linkable identifier of a component's API to its declaration
 * site: via the component's imports first, falling back to the component
 * file itself (types declared locally in the SFC). Unresolvable → null.
 */
export function collectTypeLinks(rc: ResolvedComponent, workspaceRoot: string): TypeLinkIndex {
    const index: TypeLinkIndex = new Map();
    if (rc.file === null) {
        return index;
    }
    const raw = readTextSafe(rc.file);
    if (raw === null) {
        return index;
    }
    const imports = parseScriptImports(raw);
    for (const text of apiTypeTexts(rc.api)) {
        for (const name of extractTypeIdentifiers(text)) {
            if (!index.has(name)) {
                index.set(name, resolveTypeLink(name, rc.file, workspaceRoot, imports, raw));
            }
        }
    }
    return index;
}

const typePreviewCache = new Map<string, { mtimeMs: number; preview: string | null }>();

/**
 * Declaration source of `name` in `file` for the hover preview: brace block
 * for `interface/class/enum` (and object-literal type aliases), the statement
 * with union continuation lines for `type X = …`. Rendered in full.
 */
export function extractTypePreview(file: string, name: string): string | null {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(file);
    } catch {
        return null;
    }
    const key = `${file}::${name}`;
    const cached = typePreviewCache.get(key);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
        return cached.preview;
    }
    const raw = readTextSafe(file);
    const preview = raw === null ? null : typePreviewFrom(raw, name);
    typePreviewCache.set(key, { mtimeMs: stat.mtimeMs, preview });
    return preview;
}

function typePreviewFrom(raw: string, name: string): string | null {
    const offset = findTypeDeclaration(raw, name);
    if (offset === null) {
        return null;
    }
    let start = offset;
    const exportIdx = raw.lastIndexOf('export', offset);
    if (exportIdx !== -1 && /^\s*$/.test(raw.slice(exportIdx + 'export'.length, offset))) {
        start = exportIdx;
    }
    let lineEnd = raw.indexOf('\n', offset);
    if (lineEnd === -1) {
        lineEnd = raw.length;
    }
    const header = raw.slice(offset, lineEnd);
    const braceInHeader = header.indexOf('{');
    if (braceInHeader !== -1) {
        const absBrace = offset + braceInHeader;
        const body = extractBracketBlock(raw, absBrace);
        if (body !== null) {
            return `${raw.slice(start, absBrace)}{${body}}`;
        }
    }
    if (/^type\b/.test(header)) {
        let end = lineEnd;
        while (end < raw.length) {
            const nextEnd = raw.indexOf('\n', end + 1);
            const next = raw.slice(end + 1, nextEnd === -1 ? raw.length : nextEnd).trim();
            const cur = raw.slice(start, end).trimEnd();
            if (/^[|&]/.test(next) || /[=|&,]$/.test(cur)) {
                end = nextEnd === -1 ? raw.length : nextEnd;
            } else {
                break;
            }
        }
        return raw.slice(start, end).trim();
    }
    const nextEnd = raw.indexOf('\n', lineEnd + 1);
    const nextLine = raw.slice(lineEnd + 1, nextEnd === -1 ? raw.length : nextEnd).trim();
    if (nextLine.startsWith('{')) {
        const absBrace = raw.indexOf('{', lineEnd + 1);
        const body = absBrace === -1 ? null : extractBracketBlock(raw, absBrace);
        if (absBrace !== -1 && body !== null) {
            return `${raw.slice(start, absBrace)}{${body}}`;
        }
    }
    return header.trim();
}

// ── component API extraction ────────────────────────────────────────────────

const apiCache = new Map<string, { mtimeMs: number; api: ComponentApi }>();

/** Parse the public API of an SFC file (cached by mtime). */
export function readComponentApi(vueFile: string): ComponentApi {
    const stat = fs.statSync(vueFile);
    const cached = apiCache.get(vueFile);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.api;
    }
    const raw = fs.readFileSync(vueFile, 'utf8');
    const api = parseComponentApi(raw);
    apiCache.set(vueFile, { mtimeMs: stat.mtimeMs, api });
    return api;
}

/** Parse the public API from raw SFC text. */
export function parseComponentApi(sfcText: string): ComponentApi {
    const setup = getSetupBlock(sfcText);
    if (setup === null) {
        return { ...EMPTY_API };
    }

    let props: PropInfo[] = [];
    const defaults = new Map<string, string>();
    const emits: EmitInfo[] = [];
    let models: ModelInfo[] = [];
    let expose: ExposeInfo[] = [];

    let description: string | null = null;
    for (const call of [
        ...findMacroCalls(setup, 'defineProps'),
        ...findMacroCalls(setup, 'withDefaults'),
    ]) {
        const d = docBefore(setup, call.start);
        if (d !== null) {
            description = d;
            break;
        }
    }

    for (const call of findMacroCalls(setup, 'defineProps')) {
        if (call.generic !== null && call.generic.trim().startsWith('{')) {
            const body = extractBracketBlock(call.generic, call.generic.indexOf('{'));
            if (body !== null) {
                props.push(...parsePropsMembers(body));
                continue;
            }
        }
        const arg = call.args[0] ?? '';
        if (arg.startsWith('{')) {
            props.push(...parseRuntimePropsObject(arg));
        } else if (arg.startsWith('[')) {
            for (const name of [...arg.matchAll(/['"]([^'"]+)['"]/g)].map((mm) => mm[1] ?? '')) {
                props.push({ name, type: '—', required: false, default: null, doc: null });
            }
        }
    }

    for (const call of findMacroCalls(setup, 'withDefaults')) {
        const defaultsArg = call.args[1] ?? '';
        if (defaultsArg.startsWith('{')) {
            const body = extractBracketBlock(defaultsArg, 0);
            if (body !== null) {
                for (const [k, v] of parseDefaultsObject(body)) {
                    defaults.set(k, v);
                }
            }
        }
    }

    for (const call of findMacroCalls(setup, 'defineEmits')) {
        if (call.generic !== null && call.generic.trim().startsWith('{')) {
            const body = extractBracketBlock(call.generic, call.generic.indexOf('{'));
            if (body !== null) {
                emits.push(...parseEmitsFromTypeLiteral(body));
            }
        }
        const arg = call.args[0] ?? '';
        if (arg.startsWith('[')) {
            emits.push(...parseEmitsFromArray(arg));
        }
    }

    models = parseModels(findMacroCalls(setup, 'defineModel'));

    for (const call of findMacroCalls(setup, 'defineExpose')) {
        const arg = call.args[0] ?? '';
        expose.push(...parseExpose(arg));
    }

    props = applyDefaults(props, defaults);
    return { description, props, emits, models, expose };
}

/**
 * Full resolution pipeline for a hover position: template tag → import →
 * local .vue file → parsed API.
 */
export function resolveComponentAt(
    sfcText: string,
    offset: number,
    vuePath: string,
    workspaceRoot: string,
): ResolvedComponent | null {
    const imports = parseScriptImports(sfcText);
    const tag = findComponentTagAt(sfcText, offset, imports);
    if (tag === null) {
        return null;
    }
    const file = resolveVueImport(tag.source, vuePath, workspaceRoot);
    return {
        name: tag.name,
        source: tag.source,
        file,
        api: file !== null ? readComponentApi(file) : null,
        tagStart: tag.start,
        tagEnd: tag.end,
    };
}

// ── markdown rendering ──────────────────────────────────────────────────────

const OPEN_TYPE_COMMAND = 'vue-css-jump.openType';
const TYPE_PREVIEW_LIMIT = 5;

function displayPath(file: string, workspaceRoot: string): string {
    const rel = path.relative(workspaceRoot, file);
    return rel.startsWith('..') ? file : rel;
}

/** Four-backtick fence: survives ``` inside TS sources (template literals). */
function tsFence(body: string): string {
    return `\`\`\`\`ts\n${body}\n\`\`\`\``;
}

function typeLinkMarkdown(name: string, link: TypeLink): string {
    const args = encodeURIComponent(JSON.stringify([link.file, link.line, link.character]));
    return `[${name}](command:${OPEN_TYPE_COMMAND}?${args})`;
}

function appendTypeLinksLine(
    lines: string[],
    texts: string[],
    typeIndex: TypeLinkIndex | null | undefined,
): void {
    if (typeIndex == null) {
        return;
    }
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const text of texts) {
        for (const name of extractTypeIdentifiers(text)) {
            if (seen.has(name)) {
                continue;
            }
            seen.add(name);
            const link = typeIndex.get(name);
            if (link != null) {
                parts.push(typeLinkMarkdown(name, link));
            }
        }
    }
    if (parts.length > 0) {
        lines.push(`Типы: ${parts.join(' · ')}`, '');
    }
}

function appendTypePreviews(
    lines: string[],
    typeIndex: TypeLinkIndex | null | undefined,
    workspaceRoot: string,
): void {
    if (typeIndex == null) {
        return;
    }
    const entries: Array<{ name: string; link: TypeLink; preview: string }> = [];
    for (const [name, link] of typeIndex) {
        if (link == null) {
            continue;
        }
        const preview = extractTypePreview(link.file, name);
        if (preview != null) {
            entries.push({ name, link, preview });
        }
        if (entries.length >= TYPE_PREVIEW_LIMIT) {
            break;
        }
    }
    if (entries.length === 0) {
        return;
    }
    lines.push('**Типы**', '');
    for (const { name, link, preview } of entries) {
        lines.push(
            `${typeLinkMarkdown(name, link)} — \`${displayPath(link.file, workspaceRoot)}:${link.line + 1}\``,
            '',
            tsFence(preview),
            '',
        );
    }
}

/**
 * Render the hover markdown for a resolved component: sections as ```ts
 * fences (VS Code applies theme syntax colors), command links for
 * resolvable types and declaration previews for each of them.
 */
export function renderComponentMarkdown(
    rc: ResolvedComponent,
    workspaceRoot: string,
    typeIndex?: TypeLinkIndex | null,
): string {
    const lines: string[] = [];
    const where =
        rc.file !== null
            ? `\`${displayPath(rc.file, workspaceRoot)}\``
            : `\`${rc.source}\` (не найден)`;
    lines.push(`**${rc.name}** — ${where}`, '');

    if (rc.api === null) {
        lines.push('_Компонент не удалось прочитать как локальный SFC._');
        return lines.join('\n');
    }
    const { description, props, emits, models, expose } = rc.api;
    if (description !== null) {
        lines.push(`_${description}_`, '');
    }
    if (props.length === 0 && emits.length === 0 && models.length === 0 && expose.length === 0) {
        lines.push('_Нет объявленного API (defineProps / emits / model / expose)._');
        return lines.join('\n');
    }

    if (props.length > 0) {
        const width = Math.max(...props.map((p) => p.name.length)) + 1;
        const body = props
            .map((p) => {
                let row = `${p.name.padEnd(width)}${p.required ? '' : '?'}: ${p.type}`;
                if (p.default !== null) {
                    row += `  // = ${p.default}`;
                } else if (p.required) {
                    row += '  // required';
                }
                return row;
            })
            .join('\n');
        lines.push('**Props**', '', tsFence(body), '');
        appendTypeLinksLine(lines, props.map((p) => p.type), typeIndex);
        const documentedProps = props.filter((p) => p.doc !== null);
        if (documentedProps.length > 0) {
            for (const p of documentedProps) {
                lines.push(`- \`${p.name}\` — ${p.doc}`);
            }
            lines.push('');
        }
    }
    if (emits.length > 0) {
        const body = emits
            .map((e) => `${e.name}(${e.params ? e.params.slice(1, -1) : ''}): void`)
            .join('\n');
        lines.push('**Emits**', '', tsFence(body), '');
        appendTypeLinksLine(lines, emits.map((e) => e.params), typeIndex);
        const documentedEmits = emits.filter((e) => e.doc !== null);
        if (documentedEmits.length > 0) {
            for (const e of documentedEmits) {
                lines.push(`- \`${e.name}\` — ${e.doc}`);
            }
            lines.push('');
        }
    }
    if (models.length > 0) {
        const body = models
            .map((m) => {
                let row = `${m.name}: ${m.type}`;
                if (m.required) {
                    row += '  // required';
                }
                return row;
            })
            .join('\n');
        lines.push('**v-model**', '', tsFence(body), '');
        appendTypeLinksLine(lines, models.map((m) => m.type), typeIndex);
    }
    if (expose.length > 0) {
        const body = expose.map((e) => `${e.name}${e.signature}`).join('\n');
        lines.push('**Expose**', '', tsFence(body), '');
    }
    appendTypePreviews(lines, typeIndex, workspaceRoot);
    lines.push('---', '_vue-css-jump · Ctrl+Click по тегу — открыть компонент_');
    return lines.join('\n');
}
