# Changelog

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
