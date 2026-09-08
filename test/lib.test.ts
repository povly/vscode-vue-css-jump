import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getStyleSources,
    scanClasses,
    findModuleUsageAt,
    findClassAttrUsageAt,
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
