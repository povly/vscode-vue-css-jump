# Changelog

## 0.4.0

- **New: colorized hover cards.** Card sections (props, emits, v-models,
  expose) render as ```ts code blocks instead of the monochrome gray table —
  VS Code applies the active theme's TypeScript colors, so primitives,
  identifiers and punctuation are visually distinct in every dark/light
  theme with zero palette maintenance.
- **New: go-to-type links.** Named types referenced by the component's API
  (`Tag`, `Record<string, Item>`, interfaces declared inside the SFC itself)
  render as clickable command links on a «Типы:» line — Ctrl+Click opens the
  declaration (`.ts` / `.tsx` / `.d.ts` / `.vue`, relative imports and
  tsconfig `paths` aliases) at its exact line. `import type { X }` and
  inline `{ type X }` specifiers are now parsed too.
- **New: type previews.** A «Типы» section at the bottom of the card shows
  each resolved type's declaration in full (up to 5 types) — a hover-like
  summary of every referenced type without leaving the card.
- **No truncation.** Prop types, defaults and type previews render in full —
  the former 64-character cutoff with the `…` marker is gone.
- Debug: `VUE_CSS_JUMP_DEBUG=1` additionally traces the type-link index
  (`Tag→types.ts:1, Ghost→∅`).

## 0.3.0

- **New: JSDoc in hover cards.** `/** … */` comments on type-literal members
  render in the card: the component description (JSDoc above `defineProps` /
  `withDefaults`) as the intro line, per-prop docs as a list under the props
  table, per-emit docs inline after the event signature. The same comments
  keep working natively in Volar (Ctrl+Space inside the tag, hover on an
  attribute) — one source of truth for documentation.

## 0.2.1

- **Fix: alias resolution on real-world tsconfig JSONC.** Comment stripping
  is now a string-aware state machine: `paths` values themselves contain the
  comment-opener sequence (`"@/*"`, `"./resources/js/*"`), which a plain
  regex treated as a comment start — the JSON failed to parse, aliases came
  up empty and every `@/…` component import resolved to nothing (no hover
  cards in projects importing components via aliases). Regression-tested
  with a tsconfig of that exact shape; the intellisense-check fixture now
  imports its component via `@/` too.

## 0.2.0

- **New: component hover cards** — hover over any component tag in a
  `<template>` shows a readable API summary instead of a wall of generics:
  a props table (name, type, required, default), emits with their payloads,
  `defineModel` v-models and `defineExpose` members. Works for PascalCase and
  kebab-case tags imported by the current SFC — relative specifiers and
  tsconfig `paths` aliases (`@/…`) are resolved, extension-less imports get
  `.vue` appended automatically.
- **New: component definition** — Ctrl+Click on a component tag opens the
  component file directly (the resolved `.vue`, not the import statement).
- Parses `defineProps<{…}>`, `withDefaults(…)`, runtime props
  (object/array forms), `defineEmits` (both type-literal forms + array form),
  `defineModel` and `defineExpose`. Library components (bare imports like
  `@inertiajs/vue3`) are left to native Volar.
- Logging: unresolved local imports warn once per file in the
  “Vue CSS Jump” output channel; `VUE_CSS_JUMP_DEBUG=1` enables debug traces.

## 0.1.3

- **New: diagnostics** — `<style src="…">` is validated live in every open
  `.vue` file: a missing target (wrong case / typo — Linux is case-sensitive)
  is a red error; a `module` style without the `.module.css` suffix required
  by css-modules-kit is a yellow warning. The mistake is visible the moment
  it is made, in any new component, with zero configuration.

## 0.1.2

- **Fix:** self-closing `<style … />` blocks are now parsed — previously a
  `<style src="./x.module.css" module />` block was invisible to every feature
  (no Ctrl+Click, no `$style` jumps for that component)
- **New:** HoverProvider — hover over a `src="…"` value shows the resolved
  absolute path, existence check and indexed class count; hover over
  `$style.name` lists matching selectors with file:line / inline locations
- **New:** CompletionItemProvider — `$style.` and `$style['` /
  `$style["` / `` $style[` `` now suggest the actual class names scanned from
  the component's CSS modules (works independently of tsserver plugins);
  dashed names are offered in bracket context only (after the dot they would
  parse as subtraction)

## 0.1.0

Initial public release.

- Ctrl+Click navigation: `$style.class`, `$style['kebab']`, `` $style[`tpl${x}`] `` (prefix match, peek list)
- `<style src="./file.css">` clickable paths
- static `class="..."` tokens → scoped / plain style definitions
- native CSS nesting support (`&Suffix` concatenation), compound selectors, comment exclusion
- camelCase ⇄ kebab-case name conversion
- external `src` CSS and inline `<style>` blocks
- zero configuration, multi-root workspaces
- TypeScript + Vite (lib mode) + Vitest
