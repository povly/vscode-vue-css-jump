# Changelog

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
