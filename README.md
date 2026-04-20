# vue-lsp

Vue 3 LSP plugin for Claude Code.

Combines **vue-language-server** (Volar v3) with **typescript-language-server** into a single LSP server, giving Claude Code full Vue + TypeScript intelligence for `.vue` files.

## Install

```bash
# 1. Install the server (one command installs all dependencies)
npm install -g github:popov-do/vue-lsp

# 2. Add plugin to Claude Code
/plugin marketplace add popov-do/vue-lsp
/plugin install vue-lsp@vue-lsp --scope project
/reload-plugins
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

## How it works

```
Claude Code <--stdio--> [vue-lsp-server] <--stdio--> vue-language-server (Vue/SFC)
                              |
                              +--------stdio--------> typescript-language-server (TypeScript)
```

1. **vue-language-server** handles SFC parsing, template analysis, Vue-specific diagnostics
2. **typescript-language-server** (with `@vue/typescript-plugin`) provides TypeScript intelligence
3. TS-heavy requests go to vue-ls first; if empty, fall back to ts-ls
4. `tsserver/request` notifications are proxied to ts-ls via `workspace/executeCommand`

## Testing

```bash
npm test                    # 78 unit tests (vitest, 100% coverage)
node test.js [project-dir]  # 17 integration tests
```

## Debug

Set `VUE_LSP_DEBUG=1` for verbose logging to `/tmp/vue-lsp.log`.

## License

MIT
