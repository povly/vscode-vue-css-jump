import * as fs from 'fs';
import * as path from 'path';

export interface StyleBlock {
    module: boolean;
    scoped: boolean;
    src: string | null;
    text: string | null;
    textOffset: number;
}

export interface StyleFileSource {
    path: string;
    module: boolean;
}

export interface StyleInlineSource {
    text: string;
    offset: number;
    module: boolean;
}

export interface StyleSources {
    files: StyleFileSource[];
    inlines: StyleInlineSource[];
}

export interface ClassEntry {
    name: string;
    offset: number;
}

export interface ModuleUsage {
    name: string;
    start: number;
    end: number;
    prefix: boolean;
}

export interface ClassAttrUsage {
    name: string;
    start: number;
    end: number;
}

export type ResolveHit =
    | { kind: 'file'; path: string; entry: ClassEntry }
    | { kind: 'inline'; vueOffset: number; entry: ClassEntry };

export interface ResolveOptions {
    prefix?: boolean;
    modulesOnly?: boolean;
}

const STYLE_BLOCK_RE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;

export function parseStyleBlocks(sfcText: string): StyleBlock[] {
    const blocks: StyleBlock[] = [];
    let m: RegExpExecArray | null;
    while ((m = STYLE_BLOCK_RE.exec(sfcText)) !== null) {
        const attrs = m[1] ?? '';
        const attrsNoSrc = attrs.replace(/\bsrc\s*=\s*(["'])[^"']*\1/, '');
        const srcMatch = attrs.match(/\bsrc\s*=\s*(["'])([^"']+)\1/);
        const hasSrc = srcMatch !== null;
        blocks.push({
            module: /\smodule(?=[\s>]|$)/.test(attrsNoSrc),
            scoped: /\sscoped(?=[\s>]|$)/.test(attrsNoSrc),
            src: srcMatch?.[2] ?? null,
            text: hasSrc ? null : m[2] ?? '',
            textOffset: hasSrc ? -1 : m.index + (m[0].indexOf('>') + 1),
        });
    }
    return blocks;
}

export function getStyleSources(sfcText: string, vuePath: string, workspaceRoot: string): StyleSources {
    const dir = path.dirname(vuePath);
    const files: StyleFileSource[] = [];
    const inlines: StyleInlineSource[] = [];
    for (const b of parseStyleBlocks(sfcText)) {
        if (b.src) {
            if (!b.src.startsWith('.') && !b.src.startsWith('/')) {
                continue;
            }
            const base = b.src.startsWith('/') ? workspaceRoot : dir;
            const abs = path.resolve(base, b.src);
            if (fs.existsSync(abs)) {
                files.push({ path: abs, module: b.module });
            }
        } else if (b.text && b.text.trim()) {
            inlines.push({ text: b.text, offset: b.textOffset, module: b.module });
        }
    }
    return { files, inlines };
}

export function scanClasses(text: string, baseOffset = 0): ClassEntry[] {
    // blank comments with SAME LENGTH to keep char offsets valid
    const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, (s) => ' '.repeat(s.length));
    const entries: ClassEntry[] = [];
    const stack: Array<string | null> = [];
    let offset = 0;

    for (const line of cleaned.split('\n')) {
        const lineStart = offset;
        offset += line.length + 1;
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        let lastClass: string | null = null;

        const amp = trimmed.match(/^&([A-Za-z][\w-]*)/);
        if (amp && amp[1] !== undefined) {
            const parent = [...stack].reverse().find(Boolean);
            if (parent) {
                const name = parent + amp[1];
                entries.push({ name, offset: baseOffset + lineStart + line.indexOf('&') + 1 });
                lastClass = name;
            }
        }

        // blank url(...) and strings with SAME LENGTH to keep char offsets valid
        const scanLine = line
            .replace(/url\([^)]*\)/gi, (s) => ' '.repeat(s.length))
            .replace(/("[^"]*"|'[^']*')/g, (s) => ' '.repeat(s.length));

        const classRe = /\.([_a-zA-Z][\w-]*)/g;
        let cm: RegExpExecArray | null;
        while ((cm = classRe.exec(scanLine)) !== null) {
            const name = cm[1];
            if (name === undefined) {
                continue;
            }
            const prev = cm.index > 0 ? scanLine[cm.index - 1] ?? '' : '';
            if (prev === '#' || prev === '-') {
                continue;
            }
            entries.push({ name, offset: baseOffset + lineStart + cm.index + 1 });
            lastClass = name;
        }

        const closes = (line.match(/\}/g) ?? []).length;
        const opens = (line.match(/\{/g) ?? []).length;
        for (let i = 0; i < closes && stack.length; i++) {
            stack.pop();
        }
        for (let i = 0; i < opens; i++) {
            stack.push(lastClass);
        }
    }

    return entries;
}

const fileCache = new Map<string, { mtimeMs: number; entries: ClassEntry[] }>();

export function indexCssFile(absPath: string): ClassEntry[] {
    const stat = fs.statSync(absPath);
    const cached = fileCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.entries;
    }
    const raw = fs.readFileSync(absPath, 'utf8');
    const entries = scanClasses(raw, 0);
    fileCache.set(absPath, { mtimeMs: stat.mtimeMs, entries });
    return entries;
}

export function camelize(s: string): string {
    return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function positionInText(text: string, offset: number): { line: number; character: number } {
    let line = 0;
    let lastNl = -1;
    for (let i = 0; i < offset; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            lastNl = i;
        }
    }
    return { line, character: offset - lastNl - 1 };
}

export function decamelize(s: string): string {
    return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function nameCandidates(name: string): string[] {
    return [...new Set([name, decamelize(name), camelize(name)])];
}

const MODULE_USAGE_RE =
    /\$style(?:\.([A-Za-z_$][\w$]*)|\[\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]*)`)\s*\])/g;

export function findModuleUsageAt(text: string, offset: number): ModuleUsage | null {
    MODULE_USAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODULE_USAGE_RE.exec(text)) !== null) {
        const raw = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (raw === undefined) {
            continue;
        }
        const start = m.index + m[0].indexOf(raw, m[0].startsWith('$style.') ? 7 : 0);
        const end = start + raw.length;
        if (offset >= start && offset <= end) {
            const tpl = m[4] !== undefined && raw.includes('${');
            const name = tpl ? raw.slice(0, raw.indexOf('${')) : raw;
            return { name, start, end, prefix: tpl && name.length > 0 };
        }
    }
    return null;
}

const CLASS_ATTR_RE = /(?<![\w:-])(:?class)\s*=\s*(["'])([^"'\n]*)\2/g;

export function findClassAttrUsageAt(text: string, offset: number): ClassAttrUsage | null {
    CLASS_ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLASS_ATTR_RE.exec(text)) !== null) {
        const value = m[3] ?? '';
        const valueStart = m.index + m[0].indexOf(value);
        if (offset < valueStart || offset > valueStart + value.length) {
            continue;
        }
        const tokenRe = /\S+/g;
        let t: RegExpExecArray | null;
        while ((t = tokenRe.exec(value)) !== null) {
            const tok = t[0];
            if (tok === undefined) {
                continue;
            }
            const start = valueStart + t.index;
            const end = start + tok.length;
            if (offset >= start && offset <= end) {
                return { name: tok, start, end };
            }
        }
    }
    return null;
}

export function isOnStyleBase(text: string, offset: number): boolean {
    const baseRe = /\$style(?![\w$])/g;
    let m: RegExpExecArray | null;
    while ((m = baseRe.exec(text)) !== null) {
        if (m.index > offset) {
            return false;
        }
        if (offset >= m.index && offset <= m.index + '$style'.length) {
            return true;
        }
    }
    return false;
}

function matchesEntry(entry: ClassEntry, wanted: string[], prefixMode: boolean): boolean {
    if (prefixMode) {
        return wanted.some((w) => entry.name.startsWith(w));
    }
    return wanted.includes(entry.name);
}

export function resolveClass(
    sources: StyleSources,
    name: string,
    opts: ResolveOptions = {},
): ResolveHit[] {
    const wanted = nameCandidates(name);
    const prefix = opts.prefix ?? false;
    const hits: ResolveHit[] = [];

    for (const f of sources.files) {
        if (opts.modulesOnly && !f.module) {
            continue;
        }
        for (const entry of indexCssFile(f.path)) {
            if (matchesEntry(entry, wanted, prefix)) {
                hits.push({ kind: 'file', path: f.path, entry });
            }
        }
    }

    for (const inline of sources.inlines) {
        if (opts.modulesOnly && !inline.module) {
            continue;
        }
        for (const entry of scanClasses(inline.text, inline.offset)) {
            if (matchesEntry(entry, wanted, prefix)) {
                hits.push({ kind: 'inline', vueOffset: entry.offset, entry });
            }
        }
    }

    return hits;
}
