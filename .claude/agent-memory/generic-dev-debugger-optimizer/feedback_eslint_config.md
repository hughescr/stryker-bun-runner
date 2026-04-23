---
name: ESLint flat config quirks for this project
description: Plugin registration, devDependency management, and JSON ignores in eslint.config.mjs
type: feedback
---

In ESLint flat config, plugins must be registered in EACH config object that uses their rules — they do NOT carry over between config objects even when using `...config` spread from a base.

**Why:** The `eslint.config.mjs` overrides `import-x/no-extraneous-dependencies` for `*.mjs` files in a separate config block. That block needs `plugins: { 'import-x': importX }` even though the base config registers it.

**How to apply:** When adding a new config block that uses a plugin's rules, always include `plugins: { 'plugin-name': pluginModule }` in that block. Import the plugin at the top and add it to `devDependencies` in `package.json` if it's not already a direct dep.

The `dts-bundle-generator.config.json` was being linted as JS — fix by adding `'*.json'` to the global `ignores` array.

The `eslint-plugin-import-x` package needed to be added to `devDependencies` in `package.json` (version 4.16.2) since it was only a transitive dep of `@hughescr/eslint-config-default`.
