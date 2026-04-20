# vue-lsp

Vue 3 LSP plugin for Claude Code.

Combines **vue-language-server** (Volar v3) with **typescript-language-server** into a single LSP server, giving Claude Code full Vue + TypeScript intelligence for `.vue` files.

## Why?

Volar v3 changed its architecture: it no longer handles TypeScript internally. Instead, it sends `tsserver/request` notifications back to the editor, expecting it to proxy them to a TypeScript server. Claude Code doesn't implement this protocol, so Volar v3 doesn't work out of the box.

This plugin runs both servers and bridges the protocol:

```
Claude Code <--stdio--> [vue-lsp-server] <--stdio--> vue-language-server (Vue/SFC)
                              |
                              +--------stdio--------> typescript-language-server (TypeScript)
```

## Features

| Operation | Source |
|-----------|--------|
| Hover (type info) | typescript-language-server |
| Go to Definition | typescript-language-server |
| Find References | typescript-language-server |
| Document Symbols | vue-language-server (full SFC hierarchy) |
| Call Hierarchy | typescript-language-server |
| Diagnostics | Both servers |
| Completions | typescript-language-server |
| Rename | typescript-language-server |

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

From the official marketplace (once approved):

```
/plugin install vue-lsp
```

## How it works

1. **vue-language-server** is the primary server — handles SFC parsing, template analysis, Vue-specific diagnostics
2. **typescript-language-server** (with `@vue/typescript-plugin`) provides TypeScript intelligence
3. For TS-heavy requests (hover, definition, references, etc.): vue-ls is tried first; if it returns empty, the request falls back to ts-ls
4. `tsserver/request` notifications from vue-ls are proxied to ts-ls via `workspace/executeCommand`
5. Document sync goes to both servers

## Testing

```bash
npm test                    # 78 unit tests (vitest, 100% coverage)
node test.js [project-dir]  # 17 integration tests with real LSP servers
```

## Debug

Set `VUE_LSP_DEBUG=1` environment variable for verbose logging to `/tmp/vue-lsp.log`.

## License

MIT
