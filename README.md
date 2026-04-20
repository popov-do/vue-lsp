# vue-lsp

Vue 3 LSP plugin for Claude Code.

Multiplexes **vue-language-server** (Volar v3) with **typescript-language-server** into a single LSP server, giving Claude Code full Vue + TypeScript intelligence for `.vue` files.

## Why?

Volar v3 changed its architecture: it no longer handles TypeScript internally. Instead, it sends `tsserver/request` notifications back to the editor, expecting it to proxy them to a TypeScript server. Claude Code doesn't implement this protocol, so Volar v3 doesn't work out of the box.

This plugin solves that by running both servers and acting as the bridge:

```
Claude Code <--stdio--> [multiplexer] <--stdio--> vue-language-server (Vue/SFC features)
                              |
                              +--------stdio------> typescript-language-server (TS features)
```

## Features

| Operation | Works | Source |
|-----------|-------|--------|
| Hover (type info) | Yes | typescript-language-server |
| Go to Definition | Yes | typescript-language-server |
| Find References | Yes | typescript-language-server |
| Document Symbols | Yes | vue-language-server (full SFC hierarchy) |
| Call Hierarchy | Yes | typescript-language-server |
| Diagnostics | Yes | Both servers |
| Completions | Yes | typescript-language-server |
| Rename | Yes | typescript-language-server |

## Prerequisites

Install globally:

```bash
npm install -g @vue/language-server typescript-language-server
```

Your project needs TypeScript in `node_modules`:

```bash
npm install --save-dev typescript
```

## Install

```
/plugin install vue-lsp@<marketplace>
```

Or for local development:

```
/plugin install vue-lsp@local-plugins --scope project
```

## How it works

1. **vue-language-server** is the primary server — handles SFC parsing, template analysis, Vue-specific diagnostics
2. **typescript-language-server** (with `@vue/typescript-plugin`) provides TypeScript intelligence
3. For TS-heavy requests (hover, definition, references, etc.): vue-ls is tried first; if it returns empty, the request falls back to ts-ls
4. `tsserver/request` notifications from vue-ls are intercepted and proxied to ts-ls via `workspace/executeCommand`
5. Document sync goes to both servers

## Debug

Set `VUE_LSP_DEBUG=1` environment variable for verbose logging to `/tmp/vue-lsp-wrapper.log`.

## License

MIT
