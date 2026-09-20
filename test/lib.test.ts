import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getStyleSources,
    scanClasses,
    findModuleUsageAt,
    findClassAttrUsageAt,
    findStyleSrcAt,
    findStyleSrcIssues,
    collectModuleClassNames,
    parseStyleBlocks,
    isOnStyleBase,
    resolveClass,
    camelize,
    decamelize,
} from '../src/lib';

const sfc = [
    '<template>',
    '    <section :class="$style.create">',
    '        <div :class="{ [$style.cardActive]: active }" class="legacy-card"/>',
    '    </section>',
    '</template>',
    '<script setup>',
    'const s = $style.card;',
    '</script>',
    '<style module src="./app.css"></style>',
    '<style module>',
    '.create { display: flex; }',
    '.cardActive { color: red; }',
    '</style>',
].join('\n');

let tmpDir: string;
let vuePath: string;
let sources: ReturnType<typeof getStyleSources>;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-css-jump-'));
    fs.mkdirSync(path.join(tmpDir, 'demo'), { recursive: true });
    vuePath = path.join(tmpDir, 'demo', 'Comp.vue');
    fs.writeFileSync(
        path.join(tmpDir, 'demo', 'app.css'),
        '.card { margin: 0; }\n.cardActive { color: red; }\n',
    );
    sources = getStyleSources(sfc, vuePath, tmpDir);
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('$style usage detection', () => {
    it('finds dot usage at start and mid-name', () => {
        const i = sfc.indexOf('$style.create');
        expect(findModuleUsageAt(sfc, i + 8)?.name).toBe('create');
        expect(findModuleUsageAt(sfc, i + '$style.'.length)?.name).toBe('create');
    });

    it('finds object-key usage { [$style.x]: cond }', () => {
        const i = sfc.indexOf('$style.cardActive');
        expect(findModuleUsageAt(sfc, i + 10)?.name).toBe('cardActive');
    });

    it('detects the $style base token, rejects $styles', () => {
        const i = sfc.indexOf('$style.create');
        expect(isOnStyleBase(sfc, i + 2)).toBe(true);
        expect(isOnStyleBase(`${sfc}\n styles()`, sfc.length + 3)).toBe(false);
    });

    it('handles bracket and template-literal forms', () => {
        const sample = "$style['kebab-name'] and $style[`item${variant}`]";
        expect(findModuleUsageAt(sample, sample.indexOf('kebab'))?.name).toBe('kebab-name');
        const tpl = findModuleUsageAt(sample, sample.indexOf('item'));
        expect(tpl?.prefix).toBe(true);
        expect(tpl?.name).toBe('item');
    });
});

describe('class attribute detection', () => {
    it('finds a token under the cursor', () => {
        const sample = '<div class="foo bar-baz">';
        expect(findClassAttrUsageAt(sample, sample.indexOf('bar-baz') + 2)?.name).toBe('bar-baz');
        expect(findClassAttrUsageAt(sample, sample.indexOf('div'))).toBeNull();
    });
});

describe('style sources', () => {
    it('collects external src and inline blocks', () => {
        expect(sources.files).toHaveLength(1);
        expect(sources.files[0]?.module).toBe(true);
        expect(sources.files[0]?.path).toBe(path.join(tmpDir, 'demo', 'app.css'));
        expect(sources.inlines).toHaveLength(1);
        expect(sources.inlines[0]?.module).toBe(true);
    });

    it('resolves a class into the inline block with SFC-relative offsets', () => {
        const hits = resolveClass(sources, 'cardActive', { modulesOnly: true });
        expect(hits).toHaveLength(2);
        const inline = hits.find((h) => h.kind === 'inline');
        expect(inline).toBeDefined();
        if (inline?.kind === 'inline') {
            expect(sfc.slice(inline.vueOffset, inline.vueOffset + 'cardActive'.length)).toBe('cardActive');
        }
    });

    it('resolves a class into the external css file', () => {
        const hits = resolveClass(sources, 'card', { modulesOnly: true });
        expect(hits.some((h) => h.kind === 'file' && h.entry.name === 'card')).toBe(true);
    });
});

describe('css scanner', () => {
    const css = [
        '/* .ghost comment */',
        '.input { width: 1.5rem; }',
        '.trigger.empty { color: gray; }',
        '.input {',
        '    &WithToggle { top: 0; }',
        '    &:hover { color: blue; }',
        '    &::before { content: ""; }',
        '}',
        'a { background: url(./icon.svg) no-repeat; }',
    ].join('\n');
    const names = scanClasses(css, 0).map((e) => e.name);

    it('skips commented classes', () => {
        expect(names).not.toContain('ghost');
    });

    it('skips decimals and url() hosts', () => {
        expect(names.some((n) => /^\d/.test(n))).toBe(false);
        expect(names).not.toContain('svg');
    });

    it('indexes both parts of compound selectors', () => {
        expect(names).toContain('trigger');
        expect(names).toContain('empty');
    });

    it('concatenates &Suffix onto the parent class', () => {
        expect(names).toContain('inputWithToggle');
    });

    it('ignores pseudo selectors', () => {
        expect(names).not.toContain('hover');
        expect(names).not.toContain('before');
    });
});

describe('name conventions', () => {
    it('converts camelCase and kebab-case', () => {
        expect(camelize('item-attr-title')).toBe('itemAttrTitle');
        expect(decamelize('itemAttrTitle')).toBe('item-attr-title');
    });
});

describe('self-closing style blocks', () => {
    const selfClosing = [
        '<template><div :class="$style.card"/></template>',
        '<style module src="./app.css"/>',
    ].join('\n');

    it('parses a self-closing block with src and module', () => {
        const blocks = parseStyleBlocks(selfClosing);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.module).toBe(true);
        expect(blocks[0]?.src).toBe('./app.css');
        expect(blocks[0]?.text).toBeNull();
    });

    it('collects external sources from self-closing blocks', () => {
        const s = getStyleSources(selfClosing, vuePath, tmpDir);
        expect(s.files).toHaveLength(1);
        expect(s.files[0]?.path).toBe(path.join(tmpDir, 'demo', 'app.css'));
    });

    it('parses mixed closing and self-closing blocks together', () => {
        const mixed = [
            '<style module src="./app.css"/>',
            '<style module>.extra { margin: 0; }</style>',
        ].join('\n');
        const s = getStyleSources(mixed, vuePath, tmpDir);
        expect(s.files).toHaveLength(1);
        expect(s.inlines).toHaveLength(1);
        expect(s.inlines[0]?.module).toBe(true);
    });

    it('does not treat attributes containing ">" as self-closing content', () => {
        const blocks = parseStyleBlocks('<style module>\n.a { color: red; }\n</style>');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.text).toContain('.a');
    });
});

describe('findStyleSrcAt', () => {
    it('hits inside the src value, misses outside', () => {
        const text = '<style module src="./app.css"></style>';
        const i = text.indexOf('./app.css');
        expect(findStyleSrcAt(text, i + 3)?.src).toBe('./app.css');
        expect(findStyleSrcAt(text, i - 1)).toBeNull();
    });

    it('works for self-closing form', () => {
        const text = '<style module src="./app.css"/>';
        const i = text.indexOf('./app.css');
        expect(findStyleSrcAt(text, i + 2)?.src).toBe('./app.css');
    });
});

describe('findStyleSrcIssues', () => {
    it('warns when module style lacks the .module.css suffix', () => {
        const text = '<style module src="./app.css"></style>';
        const issues = findStyleSrcIssues(text);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.severity).toBe('warning');
        expect(issues[0]?.message).toContain('.module.css');
    });

    it('reports missing file via injected exists-check (case-sensitive)', () => {
        const text = '<style module src="./Filters.module.css"></style>';
        const issues = findStyleSrcIssues(text, (src) => src === './filters.module.css');
        expect(issues).toHaveLength(1);
        expect(issues[0]?.severity).toBe('error');
        expect(issues[0]?.message).toContain('регистр');
    });

    it('stays silent for a valid .module.css reference', () => {
        const text = '<style module src="./app.module.css"></style>';
        expect(findStyleSrcIssues(text, () => true)).toEqual([]);
    });

    it('does not demand the suffix for non-module styles', () => {
        const text = '<style scoped src="./plain.css"></style>';
        expect(findStyleSrcIssues(text, () => true)).toEqual([]);
    });
});

describe('collectModuleClassNames', () => {
    it('dedupes and sorts names across module files and inlines', () => {
        expect(collectModuleClassNames(sources)).toEqual(['card', 'cardActive', 'create']);
    });

    it('skips non-module sources', () => {
        const only: ReturnType<typeof getStyleSources> = {
            files: [{ path: path.join(tmpDir, 'demo', 'app.css'), module: false }],
            inlines: [],
        };
        expect(collectModuleClassNames(only)).toEqual([]);
    });
});
