import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    parseComponentApi,
    parseScriptImports,
    findComponentTagAt,
    resolveVueImport,
    resolveModuleImport,
    extractTypeIdentifiers,
    findTypeDeclaration,
    collectTypeLinks,
    extractTypePreview,
    resolveComponentAt,
    renderComponentMarkdown,
    templateRegions,
    splitTopLevel,
    pascalize,
    type ResolvedComponent,
    type TypeLinkIndex,
} from '../src/componentInfo';

// ── fixtures: raw SFC texts ──────────────────────────────────────────────────

const buttonSfc = [
    '<script setup lang="ts">',
    "import Icon from './Icon.vue';",
    '',
    'const props = defineProps<{',
    '\ttext: string;',
    "\ttype?: 'default' | 'border' | 'border-danger' | 'border-gray' | 'transparent';",
    '\thref?: string;',
    '\ticonName?: string;',
    '\twidth?: string | number;',
    '\theight?: string | number;',
    '}>();',
    '</script>',
    '',
    '<template>',
    '\t<button :class="$style.btn"><Icon :name="iconName" />{{ text }}</button>',
    '</template>',
].join('\n');

const defaultsSfc = [
    '<script setup lang="ts">',
    'withDefaults(',
    "\tdefineProps<{ label: string; count?: number; disabled?: boolean }>(),",
    '\t{ count: 0, disabled: false },',
    ')',
    '</script>',
].join('\n');

const emitsObjectSfc = [
    '<script setup lang="ts">',
    'const emit = defineEmits<{',
    '\tchange: (value: string) => void;',
    '\tsave: [id: number, name: string];',
    '\treset: () => void;',
    '}>();',
    '</script>',
].join('\n');

const emitsClassicSfc = [
    '<script setup lang="ts">',
    "const emit = defineEmits<{ (e: 'save', id: number): void; (e: 'close'): void }>();",
    '</script>',
].join('\n');

const emitsArraySfc = [
    '<script setup lang="ts">',
    "const emit = defineEmits(['save', 'cancel']);",
    '</script>',
].join('\n');

const modelsSfc = [
    '<script setup lang="ts">',
    'const title = defineModel<string | null>();',
    "const size = defineModel('size', { type: String, required: true });",
    '</script>',
].join('\n');

const exposeSfc = [
    '<script setup lang="ts">',
    'const focus = () => input.value?.focus();',
    'defineExpose({',
    '\tfocus,',
    "\treset() { emit('reset'); },",
    '\tsubmit: (data) => save(data),',
    '\tversion: 1,',
    '});',
    '</script>',
].join('\n');

const importsSfc = [
    '<script setup lang="ts">',
    "import Default from './A.vue';",
    "import { Link } from '@inertiajs/vue3';",
    "import { X as Y } from './B.vue';",
    "import Mixed, { named1 } from './C.vue';",
    '</script>',
].join('\n');

const pageSfc = [
    '<script setup lang="ts">',
    "import ProductCard from '@/modules/catalog/components/ProductCard.vue';",
    "import Content from './Content.vue';",
    '</script>',
    '',
    '<template>',
    '\t<Content>',
    '\t\t<div class="grid">',
    '\t\t\t<ProductCard v-for="p in products" :product="p" />',
    '\t\t</div>',
    '\t</Content>',
    '</template>',
].join('\n');

const kebabSfc = [
    '<script setup lang="ts">',
    "import UiButton from './UiButton.vue';",
    '</script>',
    '<template>',
    '\t<ui-button text="Save" />',
    '</template>',
].join('\n');

const nestedTemplateSfc = [
    '<template>',
    '  <table>',
    '    <template #cell>',
    '      <span/>',
    '    </template>',
    '  </table>',
    '</template>',
].join('\n');

// ── pure parsing ─────────────────────────────────────────────────────────────

describe('splitTopLevel', () => {
    it('respects braces, brackets and strings', () => {
        expect(splitTopLevel('a: string; b: { x: 1; y: 2 }; c: number', ';\n')).toEqual([
            'a: string',
            'b: { x: 1; y: 2 }',
            'c: number',
        ]);
        expect(splitTopLevel("'a;b', c", ',')).toEqual(["'a;b'", 'c']);
        expect(splitTopLevel('f(1, 2), g([3, 4])', ',')).toEqual(['f(1, 2)', 'g([3, 4])']);
    });
});

describe('pascalize', () => {
    it('camelizes and capitalizes', () => {
        expect(pascalize('product-card')).toBe('ProductCard');
        expect(pascalize('ui-button')).toBe('UiButton');
        expect(pascalize('Content')).toBe('Content');
    });
});

describe('templateRegions', () => {
    it('outer region only — inner <template> slots counted', () => {
        const regions = templateRegions(nestedTemplateSfc);
        expect(regions.length).toBe(1);
        const [start, end] = regions[0] ?? [0, 0];
        expect(nestedTemplateSfc.slice(start, end)).toContain('<span/>');
        expect(nestedTemplateSfc.slice(start, end)).toContain('<template #cell>');
    });
});

describe('parseComponentApi — defineProps', () => {
    it('parses typed props with optional flags and unions', () => {
        const api = parseComponentApi(buttonSfc);
        expect(api.props.length).toBe(6);
        const text = api.props[0];
        expect(text).toMatchObject({ name: 'text', type: 'string', required: true, default: null });
        const type = api.props[1];
        expect(type?.name).toBe('type');
        expect(type?.required).toBe(false);
        expect(type?.type).toContain("'default'");
        expect(type?.type).toContain("'transparent'");
        expect(api.models).toEqual([]);
        expect(api.expose).toEqual([]);
    });

    it('withDefaults fills defaults and relaxes required', () => {
        const api = parseComponentApi(defaultsSfc);
        expect(api.props.find((p) => p.name === 'label')).toMatchObject({
            required: true,
            default: null,
        });
        expect(api.props.find((p) => p.name === 'count')).toMatchObject({
            required: false,
            default: '0',
        });
        expect(api.props.find((p) => p.name === 'disabled')).toMatchObject({
            default: 'false',
        });
    });
});

describe('parseComponentApi — defineEmits', () => {
    it('object form: function and tuple payloads', () => {
        const api = parseComponentApi(emitsObjectSfc);
        expect(api.emits).toEqual([
            { name: 'change', params: '(value: string)', doc: null },
            { name: 'save', params: '(id: number, name: string)', doc: null },
            { name: 'reset', params: '', doc: null },
        ]);
    });

    it('classic call-signature form', () => {
        const api = parseComponentApi(emitsClassicSfc);
        expect(api.emits).toEqual([
            { name: 'save', params: '(id: number)', doc: null },
            { name: 'close', params: '', doc: null },
        ]);
    });

    it('array form', () => {
        const api = parseComponentApi(emitsArraySfc);
        expect(api.emits.map((e) => e.name)).toEqual(['save', 'cancel']);
    });
});

describe('parseComponentApi — defineModel', () => {
    it('generic, named and runtime options', () => {
        const api = parseComponentApi(modelsSfc);
        expect(api.models).toEqual([
            { name: 'modelValue', type: 'string | null', required: false },
            { name: 'size', type: 'string', required: true },
        ]);
    });
});

describe('parseComponentApi — defineExpose', () => {
    it('shorthand, method and arrow entries', () => {
        const api = parseComponentApi(exposeSfc);
        expect(api.expose).toEqual([
            { name: 'focus', signature: '' },
            { name: 'reset', signature: '()' },
            { name: 'submit', signature: '(data)' },
            { name: 'version', signature: '' },
        ]);
    });

    it('SFC without script setup → empty API', () => {
        const api = parseComponentApi('<template><div/></template>');
        expect(api).toEqual({ description: null, props: [], emits: [], models: [], expose: [] });
    });
});

const documentedSfc = [
    '<script setup lang="ts">',
    '/**',
    ' * Карточка товара в каталоге.',
    ' */',
    'defineProps<{',
    '\t/** Текст на кнопке */',
    '\ttext: string;',
    '\tcount?: number;',
    '}>();',
    'defineEmits<{',
    "\t/** Отправляется при сохранении */",
    "\t(e: 'save', id: number): void;",
    '}>();',
    '</script>',
].join('\n');

describe('parseComponentApi — JSDoc documentation', () => {
    it('component description above defineProps + member docs', () => {
        const api = parseComponentApi(documentedSfc);
        expect(api.description).toBe('Карточка товара в каталоге.');
        expect(api.props[0]).toMatchObject({ name: 'text', doc: 'Текст на кнопке' });
        expect(api.props[1]).toMatchObject({ name: 'count', doc: null });
        expect(api.emits[0]).toMatchObject({ name: 'save', doc: 'Отправляется при сохранении' });
    });

    it('markdown renders description, prop docs and emit docs', () => {
        const md = renderComponentMarkdown(
            {
                name: 'ProductCard',
                source: './ProductCard.vue',
                file: null,
                api: parseComponentApi(documentedSfc),
                tagStart: 0,
                tagEnd: 11,
            },
            '/tmp',
        );
        expect(md).toContain('_Карточка товара в каталоге._');
        expect(md).toContain('- `text` — Текст на кнопке');
        expect(md).toContain('save(id: number): void');
        expect(md).toContain('- `save` — Отправляется при сохранении');
        expect(md).not.toContain('- `count`');
    });
});

describe('parseScriptImports', () => {
    it('default, named, aliased and mixed imports', () => {
        const imports = parseScriptImports(importsSfc);
        expect(imports.get('Default')).toBe('./A.vue');
        expect(imports.get('Link')).toBe('@inertiajs/vue3');
        expect(imports.get('Y')).toBe('./B.vue');
        expect(imports.get('Mixed')).toBe('./C.vue');
        expect(imports.get('named1')).toBe('./C.vue');
        expect(imports.size).toBe(5);
    });
});

describe('findComponentTagAt', () => {
    const imports = parseScriptImports(pageSfc);

    it('matches PascalCase tags', () => {
        // +1: aim at the tag name in the TEMPLATE (first occurrence is the import line)
        const i = pageSfc.indexOf('<ProductCard') + 1;
        const hit = findComponentTagAt(pageSfc, i + 3, imports);
        expect(hit).toMatchObject({
            name: 'ProductCard',
            source: '@/modules/catalog/components/ProductCard.vue',
            start: i,
            end: i + 'ProductCard'.length,
        });
    });

    it('matches kebab-case tags against PascalCase imports', () => {
        const kebabImports = parseScriptImports(kebabSfc);
        const i = kebabSfc.indexOf('ui-button');
        expect(findComponentTagAt(kebabSfc, i + 2, kebabImports)).toMatchObject({
            name: 'UiButton',
            source: './UiButton.vue',
        });
    });

    it('closing tag resolves too', () => {
        const i = pageSfc.indexOf('</Content');
        const hit = findComponentTagAt(pageSfc, i + 3, imports);
        expect(hit?.name).toBe('Content');
    });

    it('plain HTML tag → null', () => {
        const i = pageSfc.indexOf('div');
        expect(findComponentTagAt(pageSfc, i + 1, imports)).toBeNull();
    });

    it('offset outside template → null', () => {
        const i = pageSfc.indexOf('import Content');
        expect(findComponentTagAt(pageSfc, i + 2, imports)).toBeNull();
    });
});

// ── fs-backed resolution ─────────────────────────────────────────────────────

let tmpDir: string;
let comp: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-css-jump-ci-'));
    comp = path.join(tmpDir, 'demo', 'Comp.vue');
    fs.writeFileSync(
        path.join(tmpDir, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                baseUrl: '.',
                paths: { '@/*': ['./resources/js/*'] },
            },
        }),
    );
    fs.mkdirSync(path.join(tmpDir, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'demo', 'Comp.vue'), '<template><div/></template>');
    fs.writeFileSync(
        path.join(tmpDir, 'demo', 'Icon.vue'),
        [
            '<script setup lang="ts">',
            "defineProps<{ name: string; width?: number }>();",
            '</script>',
        ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, 'resources/js/components/ui'), { recursive: true });
    fs.writeFileSync(
        path.join(tmpDir, 'resources/js/components/ui', 'Button.vue'),
        buttonSfc.replace("import Icon from './Icon.vue';", ''),
    );
    fs.writeFileSync(
        path.join(tmpDir, 'demo', 'Page.vue'),
        [
            '<script setup lang="ts">',
            "import UiButton from '@/components/ui/Button';",
            '</script>',
            '<template>',
            '\t<UiButton text="Save" />',
            '</template>',
        ].join('\n'),
    );
    fs.writeFileSync(
        path.join(tmpDir, 'demo', 'types.ts'),
        [
            'export interface Tag {',
            '    id: number;',
            '    label: string;',
            '}',
            '',
            "export type Size = 'sm' | 'lg';",
            '',
            'export type Status =',
            "    | 'active'",
            "    | 'disabled';",
            '',
            'export interface Huge {',
            ...Array.from({ length: 20 }, (_, i) => `    f${i}: number;`),
            '}',
        ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, 'demo', 'util'), { recursive: true });
    fs.writeFileSync(
        path.join(tmpDir, 'demo', 'util', 'index.ts'),
        'export interface Util { ok: boolean }\n',
    );
    fs.writeFileSync(
        path.join(tmpDir, 'resources/js', 'shapes.ts'),
        'export interface Shape { kind: string }\n',
    );
    fs.writeFileSync(
        path.join(tmpDir, 'demo', 'Typed.vue'),
        [
            '<script setup lang="ts">',
            "import type { Tag } from './types';",
            "import { type Size } from './types';",
            'interface LocalShape {',
            '    x: number;',
            '    y: number;',
            '}',
            'defineProps<{ tag: Tag; size?: Size; local: LocalShape; mystery: Ghost }>();',
            '</script>',
            '<template><div/></template>',
        ].join('\n'),
    );
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveVueImport', () => {
    it('relative with and without extension', () => {
        expect(resolveVueImport('./Icon.vue', comp, tmpDir)).toBe(path.join(tmpDir, 'demo', 'Icon.vue'));
        expect(resolveVueImport('./Icon', comp, tmpDir)).toBe(path.join(tmpDir, 'demo', 'Icon.vue'));
        expect(resolveVueImport('../demo/Icon.vue', comp, tmpDir)).toBe(path.join(tmpDir, 'demo', 'Icon.vue'));
    });

    it('alias from tsconfig paths, with and without extension', () => {
        const wanted = path.join(tmpDir, 'resources/js/components/ui/Button.vue');
        expect(resolveVueImport('@/components/ui/Button.vue', comp, tmpDir)).toBe(wanted);
        expect(resolveVueImport('@/components/ui/Button', comp, tmpDir)).toBe(wanted);
    });

    it('bare package specifier → null', () => {
        expect(resolveVueImport('@inertiajs/vue3', comp, tmpDir)).toBeNull();
    });

    it('missing relative file → null', () => {
        expect(resolveVueImport('./Nope.vue', comp, tmpDir)).toBeNull();
    });
});

describe('tsconfig alias parsing — real-world JSONC shape', () => {
    it('block comments + "/*" inside path values do not break aliases', () => {
        // Форма реального tsconfig.json (<laravel-проект>): блочные комментарии
        // до/после paths, НО сами значения "…/*" содержат "/*" — регексп-стриппер
        // принимал его за начало комментария и ломал JSON (регрессия 0.2.0).
        const toxicTsconfig = [
            '{',
            '  "compilerOptions": {',
            '    /* Visit https://aka.ms/tsconfig to read more about this file */',
            '    "target": "ESNext" /* Set the JavaScript language version */,',
            '    // "composite": true,                              /* Enable constraints */',
            '    "baseUrl": ".",',
            '    "paths": {',
            '      /* Specify a set of entries that re-map imports. */ "@/*": [',
            '        "./resources/js/*"',
            '      ]',
            '    },',
            '    /* Specify type package names to be included. */',
            '    "strict": true',
            '  }',
            '}',
        ].join('\n');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-css-jump-realts-'));
        try {
            fs.writeFileSync(path.join(dir, 'tsconfig.json'), toxicTsconfig);
            fs.mkdirSync(path.join(dir, 'resources/js/components/ui'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'resources/js/components/ui', 'Button.vue'),
                buttonSfc.replace("import Icon from './Icon.vue';", ''),
            );
            fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
            const page = path.join(dir, 'demo', 'Page.vue');
            expect(resolveVueImport('@/components/ui/Button.vue', page, dir)).toBe(
                path.join(dir, 'resources/js/components/ui/Button.vue'),
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('resolveComponentAt + renderComponentMarkdown', () => {
    it('full pipeline: tag → alias import → file → api → markdown', () => {
        const vuePath = path.join(tmpDir, 'demo', 'Page.vue');
        const text = fs.readFileSync(vuePath, 'utf8');
        // +1: first occurrence is the import line — hover targets the template tag
        const offset = text.indexOf('<UiButton') + 1;
        const rc = resolveComponentAt(text, offset, vuePath, tmpDir);
        expect(rc).not.toBeNull();
        expect(rc?.file).toBe(path.join(tmpDir, 'resources/js/components/ui/Button.vue'));
        expect(rc?.api?.props[0]).toMatchObject({ name: 'text', required: true });
        expect(rc?.tagStart).toBe(offset);
        expect(rc?.tagEnd).toBe(offset + 'UiButton'.length);

        const md = renderComponentMarkdown(rc as NonNullable<typeof rc>, tmpDir);
        expect(md).toContain('**UiButton**');
        expect(md).toContain('`resources/js/components/ui/Button.vue`');
        expect(md).toContain('````ts');
        expect(md).toMatch(/text\s+: string\s+\/\/ required/);
        expect(md).toMatch(/type\s+\?\s*:/);
        expect(md).toContain("'default' | 'border'");
    });

    it('markdown lists emits, models and expose', () => {
        const md = renderComponentMarkdown(
            {
                name: 'Editor',
                source: './Editor.vue',
                file: path.join(tmpDir, 'demo', 'Icon.vue'),
                api: {
                    description: null,
                    props: [{ name: 'label', type: 'string', required: true, default: null, doc: null }],
                    emits: [
                        { name: 'change', params: '(value: string)', doc: null },
                        { name: 'reset', params: '', doc: null },
                    ],
                    models: [{ name: 'modelValue', type: 'string | null', required: false }],
                    expose: [{ name: 'focus', signature: '' }],
                },
                tagStart: 0,
                tagEnd: 6,
            },
            tmpDir,
        );
        expect(md).toContain('**Emits**');
        expect(md).toContain('change(value: string): void');
        expect(md).toContain('reset(): void');
        expect(md).toContain('**v-model**');
        expect(md).toContain('modelValue: string | null');
        expect(md).toContain('**Expose**');
    });

    it('missing file renders a not-found note', () => {
        const md = renderComponentMarkdown(
            {
                name: 'Link',
                source: '@inertiajs/vue3',
                file: null,
                api: null,
                tagStart: 0,
                tagEnd: 4,
            },
            tmpDir,
        );
        expect(md).toContain('не найден');
    });
});

// ── type links: identifiers, declarations, previews ─────────────────────────

describe('extractTypeIdentifiers', () => {
    it('flattens generics and filters primitives/utils', () => {
        expect(extractTypeIdentifiers('Array<Tag>')).toEqual(['Tag']);
        expect(extractTypeIdentifiers('Record<string, Tag>')).toEqual(['Tag']);
        expect(extractTypeIdentifiers('string | number')).toEqual([]);
        expect(extractTypeIdentifiers('Promise<Tag[]>')).toEqual(['Tag']);
    });

    it('ignores string-literal union members and deduplicates', () => {
        expect(extractTypeIdentifiers("'default' | 'border'")).toEqual([]);
        expect(extractTypeIdentifiers('Tag | OtherTag | Tag')).toEqual(['Tag', 'OtherTag']);
    });
});

describe('findTypeDeclaration', () => {
    it('finds interface, type, class and enum keywords', () => {
        expect(findTypeDeclaration('export interface Tag {}', 'Tag')).toBe(7);
        expect(findTypeDeclaration("type Size = 'sm';", 'Size')).toBe(0);
        expect(findTypeDeclaration('class Foo {}', 'Foo')).toBe(0);
        expect(findTypeDeclaration('enum Color {}', 'Color')).toBe(0);
    });

    it('escapes $ in names and returns null when absent', () => {
        expect(findTypeDeclaration('type Cash$ = number', 'Cash$')).toBe(0);
        expect(findTypeDeclaration('const x = 1', 'Tag')).toBeNull();
    });
});

describe('parseScriptImports — type-only imports', () => {
    it('import type / inline type specifiers map to their source', () => {
        const sfc = [
            '<script setup lang="ts">',
            "import type { Tag } from './types';",
            "import { type Size, Other } from './x';",
            "import type Foo from './foo';",
            '</script>',
        ].join('\n');
        const imports = parseScriptImports(sfc);
        expect(imports.get('Tag')).toBe('./types');
        expect(imports.get('Size')).toBe('./x');
        expect(imports.get('Other')).toBe('./x');
        expect(imports.get('Foo')).toBe('./foo');
    });
});

describe('resolveModuleImport', () => {
    const exts = ['.ts', '.tsx', '.d.ts', '.vue'];

    it('resolves .ts, alias and directory index', () => {
        expect(resolveModuleImport('./types', comp, tmpDir, exts)).toBe(
            path.join(tmpDir, 'demo', 'types.ts'),
        );
        expect(resolveModuleImport('@/shapes', comp, tmpDir, exts)).toBe(
            path.join(tmpDir, 'resources/js', 'shapes.ts'),
        );
        expect(resolveModuleImport('./util', comp, tmpDir, exts)).toBe(
            path.join(tmpDir, 'demo', 'util', 'index.ts'),
        );
    });

    it('missing files and bare specifiers → null', () => {
        expect(resolveModuleImport('./Ghost', comp, tmpDir, exts)).toBeNull();
        expect(resolveModuleImport('lodash', comp, tmpDir, exts)).toBeNull();
    });
});

describe('collectTypeLinks', () => {
    it('resolves imported, inline-specifier and local SFC types; unknown → null', () => {
        const typedVue = path.join(tmpDir, 'demo', 'Typed.vue');
        const rc: ResolvedComponent = {
            name: 'Typed',
            source: './Typed.vue',
            file: typedVue,
            api: parseComponentApi(fs.readFileSync(typedVue, 'utf8')),
            tagStart: 0,
            tagEnd: 5,
        };
        const idx = collectTypeLinks(rc, tmpDir);
        expect(idx.get('Tag')).toEqual({
            file: path.join(tmpDir, 'demo', 'types.ts'),
            line: 0,
            character: 7,
        });
        expect(idx.get('Size')).toEqual({
            file: path.join(tmpDir, 'demo', 'types.ts'),
            line: 5,
            character: 7,
        });
        expect(idx.get('LocalShape')).toEqual({ file: typedVue, line: 3, character: 0 });
        expect(idx.get('Ghost')).toBeNull();
    });
});

describe('extractTypePreview', () => {
    // tmpDir is only assigned in beforeAll — evaluate lazily inside tests.
    const typesTs = (): string => path.join(tmpDir, 'demo', 'types.ts');

    it('interface brace block and single-line type alias', () => {
        expect(extractTypePreview(typesTs(), 'Tag')).toBe(
            'export interface Tag {\n    id: number;\n    label: string;\n}',
        );
        expect(extractTypePreview(typesTs(), 'Size')).toBe("export type Size = 'sm' | 'lg';");
    });

    it('multiline union keeps continuation lines', () => {
        expect(extractTypePreview(typesTs(), 'Status')).toBe(
            "export type Status =\n    | 'active'\n    | 'disabled';",
        );
    });

    it('renders long declarations in full without ellipsis', () => {
        const preview = extractTypePreview(typesTs(), 'Huge');
        expect(preview).not.toBeNull();
        expect(preview?.split('\n').length).toBe(22);
        expect(preview?.endsWith('}')).toBe(true);
        expect(preview).not.toContain('…');
    });

    it('unknown name and missing file → null', () => {
        expect(extractTypePreview(typesTs(), 'Nope')).toBeNull();
        expect(extractTypePreview(path.join(tmpDir, 'no-file.ts'), 'Tag')).toBeNull();
    });
});

describe('renderComponentMarkdown — type links', () => {
    it('renders command links with URI-encoded args', () => {
        const idx: TypeLinkIndex = new Map([
            ['Tag', { file: '/tmp/x.ts', line: 3, character: 5 }],
        ]);
        const md = renderComponentMarkdown(
            {
                name: 'C',
                source: './C.vue',
                file: null,
                api: {
                    description: null,
                    props: [{ name: 'tag', type: 'Tag', required: true, default: null, doc: null }],
                    emits: [],
                    models: [],
                    expose: [],
                },
                tagStart: 0,
                tagEnd: 1,
            },
            '/tmp',
            idx,
        );
        const args = encodeURIComponent(JSON.stringify(['/tmp/x.ts', 3, 5]));
        expect(md).toContain(`[Tag](command:vue-css-jump.openType?${args})`);
        expect(md).toContain('Типы: [Tag]');
    });
});
