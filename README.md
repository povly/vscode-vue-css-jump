# Vue CSS Jump

Ctrl+Click navigation for Vue Single-File Components and CSS modules —
fills the gaps Volar leaves with `<style module src="...">`, external CSS
files and component API summaries on hover.

## Features

**Jump from template to styles:**

- `$style.className` → the class definition in the CSS file
- `$style['kebab-name']` → same, kebab-case form
- `` $style[`item${dynamic}`] `` → prefix resolution, QuickPick when several classes match
- `$style` itself → opens the component's CSS file
- static `class="..."` tokens → definitions in scoped / plain styles
- `<style src="./file.css">` → the path is Ctrl+Clickable

**Understands real-world CSS:**

- CSS modules naming: `camelCase` ⇄ `kebab-case` conversion
- native nesting: `&WithToggle` inside `.input {}` → class `inputWithToggle`
- compound selectors `.trigger.empty`, pseudo forms `&:hover` / `&::before` / `&[disabled]` are ignored
- comments are not indexed
- external `src` files **and** inline `<style>` blocks (jumps inside the SFC)

**Smart open:**

navigation goes through Go to Definition (Ctrl+Click / F12): several matches
are shown in the built-in peek list, and with the
`"workbench.editor.revealIfOpen": true` setting already opened editors are
reused instead of duplicated.

**Component API on hover:**

- hover over any component tag in a `<template>` — a readable card instead
  of a wall of generics: props (name / type / required / default), emits
  with payloads, `defineModel` v-models and `defineExpose` members
- sections render as ```ts code blocks, so VS Code colorizes them with the
  active theme's TypeScript colors — no monochrome gray, adapts to every
  dark/light theme automatically
- named types in the card (`Tag`, `Record<string, Item>`, interfaces
  declared inside the SFC itself) become clickable links on the «Типы:»
  line — Ctrl+Click jumps to the type's declaration (`.ts` / `.tsx` /
  `.d.ts` / `.vue`, relative and `@/…` alias imports)
- a «Типы» section with full declaration previews (up to 5 types) gives
  every referenced type its own hover-like summary in the card
- PascalCase and kebab-case tags; relative imports and tsconfig `paths`
  aliases (`@/…`) resolve, extension-less specifiers get `.vue` appended
- Ctrl+Click on a component tag opens the component file itself
- library components (bare imports, e.g. `@inertiajs/vue3`) stay on Volar

**Zero configuration:** no settings, no project coupling — the workspace root is
derived per document, so it works in any folder and in multi-root workspaces.
Keep the `workbench.editor.revealIfOpen: true` setting for F12/Go-to-Definition
to reuse opened editors as well.

## Install

Download the latest `.vsix` from [Releases](../../releases) and run:

```bash
code --install-extension vscode-vue-css-jump-<version>.vsix
```

Requires the Vue (Volar) extension for `.vue` language support. Vue CSS Jump
only adds navigation on top — it does not replace Volar.

## Limitations

- `$style[someVariable]` cannot be resolved statically (no class name at edit time)
- component cards are parsed textually (no TS AST): `defineProps<NamedInterface>`
  (non-literal generic) shows as "no declared API"
- command links cannot live inside code blocks (VS Code platform) — type
  links sit on the «Типы:» line after each section instead; nested hovers do
  not exist, hence the declaration previews
- type resolution is textual: re-exports (`export type { A } from …`) are
  not followed
- the CSS scanner is line-based: selectors are expected one per line —
  any formatted CSS qualifies; minified single-line CSS does not
- a file opened in a **separate VS Code window** cannot be focused from another
  window — VS Code extensions have no cross-window tab API; the file opens in
  the current window instead

## Development

TypeScript + Vite (lib mode → CJS bundle) + Vitest:

```bash
npm install
npm test              # vitest unit checks for the parsing/resolution core
npm run package       # typecheck + vite build + .vsix in dist/
code --install-extension dist/*.vsix --force
```

## License

[MIT](LICENSE)
