#!/usr/bin/env node

/**
 * Integration test for vue-lsp-server.
 *
 * Spawns the multiplexer, sends LSP requests, and verifies responses.
 * Requires: vue-language-server, typescript-language-server, and a project
 * with node_modules/typescript at CWD.
 *
 * Usage:
 *   node test.js [project-root]
 *
 * Defaults project-root to CWD.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.argv[2] || process.cwd();
const SERVER = path.join(__dirname, 'vue-lsp-server.js');

// --- Helpers ---

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ': ' + detail : ''}`);
  }
}

function encode(obj) {
  const content = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
}

function parseResponses(raw) {
  const results = [];
  const parts = raw.split(/(?=Content-Length:)/);
  for (const part of parts) {
    const idx = part.indexOf('{');
    if (idx >= 0) {
      try { results.push(JSON.parse(part.substring(idx))); } catch {}
    }
  }
  return results;
}

// --- Find a .vue test file ---

function findVueFile(dir) {
  // Find a .vue file that has imports in <script> (needed for hover/definition tests)
  function hasImports(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    return /^import\s+/m.test(text);
  }

  function walk(d, depth) {
    if (depth > 5) return [];
    const results = [];
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = path.join(d, entry.name);
        if (entry.isFile() && entry.name.endsWith('.vue')) results.push(full);
        if (entry.isDirectory()) results.push(...walk(full, depth + 1));
        if (results.length > 50) break;
      }
    } catch {}
    return results;
  }

  const files = walk(dir, 0);
  // Prefer files with imports
  for (const f of files) {
    if (hasImports(f)) return f;
  }
  return files[0] || null;
}

// --- Main ---

async function main() {
  console.log(`\nVue LSP Wrapper — Integration Tests`);
  console.log(`Project: ${PROJECT_ROOT}\n`);

  // Preflight checks
  const tsPath = path.join(PROJECT_ROOT, 'node_modules/typescript/lib/tsserver.js');
  if (!fs.existsSync(tsPath)) {
    console.error('Error: node_modules/typescript not found at project root');
    process.exit(1);
  }

  const vueFile = findVueFile(PROJECT_ROOT);
  if (!vueFile) {
    console.error('Error: no .vue file found in project');
    process.exit(1);
  }

  const vueFileRelative = path.relative(PROJECT_ROOT, vueFile);
  const vueFileUri = 'file://' + vueFile;
  const vueText = fs.readFileSync(vueFile, 'utf8');

  console.log(`Test file: ${vueFileRelative}`);
  console.log('');

  // Spawn server
  const cp = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });

  let allOut = '';
  let stderr = '';
  cp.stdout.on('data', (d) => { allOut += d.toString(); });
  cp.stderr.on('data', (d) => { stderr += d.toString(); });

  function send(obj) {
    cp.stdin.write(encode(obj));
  }

  function waitForId(id, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        const msgs = parseResponses(allOut);
        const found = msgs.find((m) => m.id === id);
        if (found) {
          clearInterval(check);
          resolve(found);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(check);
          reject(new Error(`Timeout waiting for id=${id}`));
        }
      }, 100);
    });
  }

  // --- Test: Initialize ---
  console.log('1. Initialize');
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: 'file://' + PROJECT_ROOT,
      workspaceFolders: [{ uri: 'file://' + PROJECT_ROOT, name: 'root' }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
      initializationOptions: { typescript: { tsdk: 'node_modules/typescript/lib' } },
    },
  });

  const initResp = await waitForId(1);
  assert('Server initializes', initResp.result && initResp.result.capabilities);
  assert('Has hover provider', initResp.result.capabilities.hoverProvider === true);
  assert('Has definition provider', initResp.result.capabilities.definitionProvider === true);
  assert('Has references provider', initResp.result.capabilities.referencesProvider === true);
  assert('Has document symbol provider', initResp.result.capabilities.documentSymbolProvider === true);
  assert('Server info present', initResp.result.serverInfo && initResp.result.serverInfo.name === '@vue/language-server');

  // --- Send initialized + open file ---
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: vueFileUri, languageId: 'vue', version: 1, text: vueText } },
  });

  // Wait for servers to warm up
  await new Promise((r) => setTimeout(r, 12000));

  // --- Test: Document Symbols ---
  console.log('\n2. Document Symbols');
  send({ jsonrpc: '2.0', id: 10, method: 'textDocument/documentSymbol', params: { textDocument: { uri: vueFileUri } } });
  const symbolResp = await waitForId(10);
  const symbols = symbolResp.result;
  assert('Returns symbols array', Array.isArray(symbols));
  assert('Has symbols', symbols && symbols.length > 0);
  const hasTemplate = symbols && symbols.some((s) => s.name === 'template');
  const hasScript = symbols && symbols.some((s) => s.name && s.name.includes('script'));
  assert('Contains template section', hasTemplate);
  assert('Contains script section', hasScript);

  // --- Test: Hover (TS fallback) ---
  console.log('\n3. Hover');

  // Find a line with an import or const to hover on
  const lines = vueText.split('\n');
  let hoverLine = -1;
  let hoverChar = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^import\s+\{?\s*(\w+)/);
    if (match) {
      hoverLine = i;
      hoverChar = lines[i].indexOf(match[1]);
      break;
    }
  }
  if (hoverLine === -1) {
    // Try const
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^const\s+(\w+)/);
      if (match) {
        hoverLine = i;
        hoverChar = lines[i].indexOf(match[1]);
        break;
      }
    }
  }

  if (hoverLine >= 0) {
    send({
      jsonrpc: '2.0', id: 20, method: 'textDocument/hover',
      params: { textDocument: { uri: vueFileUri }, position: { line: hoverLine, character: hoverChar } },
    });
    const hoverResp = await waitForId(20);
    assert('Hover returns result', hoverResp.result !== null);
    assert('Hover has contents', hoverResp.result && hoverResp.result.contents);
  } else {
    console.log('  (skipped — no suitable hover target found)');
  }

  // --- Test: Go to Definition (TS fallback) ---
  console.log('\n4. Go to Definition');

  // Find an import to test definition
  let defLine = -1;
  let defChar = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/from\s+['"]([^'"]+)['"]/);
    if (match) {
      defLine = i;
      // Put cursor on the import specifier
      const importMatch = lines[i].match(/import\s+\{?\s*(\w+)/);
      if (importMatch) {
        defChar = lines[i].indexOf(importMatch[1]);
      }
      break;
    }
  }

  if (defLine >= 0 && defChar > 0) {
    send({
      jsonrpc: '2.0', id: 30, method: 'textDocument/definition',
      params: { textDocument: { uri: vueFileUri }, position: { line: defLine, character: defChar } },
    });
    const defResp = await waitForId(30);
    const defs = defResp.result;
    assert('Definition returns result', defs !== null);
    assert('Definition is non-empty', Array.isArray(defs) ? defs.length > 0 : defs !== null);
  } else {
    console.log('  (skipped — no suitable definition target found)');
  }

  // --- Test: Find References ---
  console.log('\n5. Find References');
  if (hoverLine >= 0) {
    send({
      jsonrpc: '2.0', id: 40, method: 'textDocument/references',
      params: {
        textDocument: { uri: vueFileUri },
        position: { line: hoverLine, character: hoverChar },
        context: { includeDeclaration: true },
      },
    });
    const refResp = await waitForId(40);
    assert('References returns result', refResp.result !== null);
    assert('References is array', Array.isArray(refResp.result));
  } else {
    console.log('  (skipped)');
  }

  // --- Test: Shutdown ---
  console.log('\n6. Shutdown');
  send({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: null });
  const shutdownResp = await waitForId(99, 5000).catch(() => null);
  assert('Shutdown responds', shutdownResp !== null);

  // --- Results ---
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  console.log('');

  cp.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
