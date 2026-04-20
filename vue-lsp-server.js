#!/usr/bin/env node

/**
 * Vue LSP Server for Volar v3
 *
 * Combines vue-language-server v3 (Vue/SFC features) with
 * typescript-language-server (TypeScript features) into a single LSP server.
 *
 * Architecture:
 *   Editor <--stdio--> [multiplexer] <--stdio--> vue-language-server (primary)
 *                            |
 *                            +--------stdio------> typescript-language-server (TS fallback)
 *
 * Routing strategy:
 * - vue-ls is the primary server (initialize, SFC, template, formatting, diagnostics)
 * - TS-heavy requests (hover, definition, references, etc.) go to vue-ls first;
 *   if null/empty, they fall back to ts-ls
 * - Some requests go directly to ts-ls (workspaceSymbol, completionItem/resolve)
 * - tsserver/request from vue-ls is proxied to ts-ls via workspace/executeCommand
 * - Document sync (didOpen/didChange/didClose) goes to both servers
 * - shutdown/exit go to both servers
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const {
  parseMessages, encode, isEmpty, uriToPath,
  routeRequest, parseTsServerRequestParams,
  extractTsResponseBody, buildTsServerResponse, buildTsServerCommand,
} = require('./lib');

// --- Platform ---
const IS_WIN = process.platform === 'win32';
const WHICH_CMD = IS_WIN ? 'where' : 'which';

// --- Logging ---
// Set VUE_LSP_DEBUG=1 for verbose logging to a log file.
// Without it, only errors go to stderr (no log file created).
const DEBUG = process.env.VUE_LSP_DEBUG === '1';
let logStream = null;

if (DEBUG) {
  const LOG_FILE = IS_WIN ? path.join(process.env.TEMP || '.', 'vue-lsp.log')
                          : '/tmp/vue-lsp.log';
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

function log(tag, msg) {
  if (logStream) logStream.write(`[${new Date().toISOString()}] [${tag}] ${msg}\n`);
}

function debug(tag, msg) {
  if (DEBUG) log(tag, msg);
}

log('INIT', `=== Vue LSP Multiplexer v1.0 === PID=${process.pid} CWD=${process.cwd()}`);

// --- Preflight: check dependencies ---

function checkBinary(name, installCmd) {
  try {
    execSync(`${WHICH_CMD} ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    const msg = `[vue-lsp] ERROR: "${name}" not found.\n  Install: ${installCmd}\n`;
    process.stderr.write(msg);
    log('ERROR', msg.trim());
    return false;
  }
}

const hasVueLs = checkBinary('vue-language-server', 'npm install -g @vue/language-server');
const hasTsLs = checkBinary('typescript-language-server', 'npm install -g typescript-language-server');

if (!hasVueLs || !hasTsLs) {
  process.stderr.write('\n[vue-lsp] Install missing dependencies and restart.\n');
  log('FATAL', 'Missing dependencies, exiting');
  process.exit(1);
}

// --- Configuration ---
const VUE_LS_CMD = process.env.VUE_LS_CMD || 'vue-language-server';
const TS_LS_CMD = process.env.TS_LS_CMD || 'typescript-language-server';

// --- State ---

let nextTsId = 200000;
const tsProxyRequests = new Map();    // tsId → { vueRequestId }
const tsFallbackRequests = new Map(); // tsId → { editorId, method }
const pendingFallbacks = new Map();   // editorId → { method, params }

let vueBuffer = Buffer.alloc(0);
let tsBuffer = Buffer.alloc(0);
let editorBuffer = Buffer.alloc(0);

let tsInitialized = false;
let tsInitId = null;
let tsInitQueue = [];
let capturedRootUri = null;
let capturedWorkspaceFolders = null;
let capturedInitOptions = null;
let capturedCapabilities = null;

// --- Spawn servers ---

const vueLs = spawn(VUE_LS_CMD, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
const tsLs = spawn(TS_LS_CMD, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });

log('SPAWN', `vue-ls PID=${vueLs.pid}, ts-ls PID=${tsLs.pid}`);

vueLs.on('error', (e) => log('ERROR', `vue-ls spawn: ${e.message}`));
tsLs.on('error', (e) => log('ERROR', `ts-ls spawn: ${e.message}`));
vueLs.stderr.on('data', (d) => log('vue-ls:stderr', d.toString().trim()));
tsLs.stderr.on('data', (d) => log('ts-ls:stderr', d.toString().trim()));
vueLs.on('exit', (code) => { log('EXIT', `vue-ls code=${code}`); shutdown(); });
tsLs.on('exit', (code) => { log('EXIT', `ts-ls code=${code}`); });

// =====================================================================
// Editor → Multiplexer
// =====================================================================

process.stdin.on('data', (chunk) => {
  editorBuffer = Buffer.concat([editorBuffer, chunk]);
  const { messages, remaining } = parseMessages(editorBuffer);
  editorBuffer = remaining;

  for (const raw of messages) {
    const msg = JSON.parse(raw);
    const method = msg.method;
    const id = msg.id;
    const route = routeRequest(method, id);

    debug('ROUTE', `${method || 'response'} id=${id || '-'} → ${route}`);

    switch (route) {
      case 'initialize':
        capturedRootUri = msg.params.rootUri;
        capturedWorkspaceFolders = msg.params.workspaceFolders;
        capturedInitOptions = msg.params.initializationOptions;
        capturedCapabilities = msg.params.capabilities;
        initializeTs();
        vueLs.stdin.write(encode(msg));
        break;

      case 'both':
        vueLs.stdin.write(encode(msg));
        if (tsInitialized) tsLs.stdin.write(encode(msg));
        if (method === 'exit') shutdown();
        break;

      case 'ts-only': {
        const tsId = nextTsId++;
        tsFallbackRequests.set(tsId, { editorId: id, method });
        tsLs.stdin.write(encode({ ...msg, id: tsId }));
        break;
      }

      case 'fallback':
        pendingFallbacks.set(id, { method, params: msg.params });
        vueLs.stdin.write(encode(msg));
        break;

      default: // 'vue'
        vueLs.stdin.write(encode(msg));
        break;
    }
  }
});

// =====================================================================
// Vue LS → Multiplexer → Editor
// =====================================================================

vueLs.stdout.on('data', (chunk) => {
  vueBuffer = Buffer.concat([vueBuffer, chunk]);
  const { messages, remaining } = parseMessages(vueBuffer);
  vueBuffer = remaining;

  for (const raw of messages) {
    const msg = JSON.parse(raw);

    // --- tsserver/request proxy ---
    if (msg.method === 'tsserver/request') {
      handleTsServerRequest(msg.params);
      continue;
    }

    // --- Fallback check ---
    if (msg.id !== undefined && pendingFallbacks.has(msg.id)) {
      const fb = pendingFallbacks.get(msg.id);
      pendingFallbacks.delete(msg.id);

      if (isEmpty(msg.result)) {
        debug('FALLBACK', `${fb.method} id=${msg.id} → ts-ls`);
        const tsId = nextTsId++;
        tsFallbackRequests.set(tsId, { editorId: msg.id, method: fb.method });
        tsLs.stdin.write(encode({
          jsonrpc: '2.0',
          id: tsId,
          method: fb.method,
          params: fb.params,
        }));
        continue;
      }

      debug('VUE', `${fb.method} id=${msg.id} → editor (vue had result)`);
      process.stdout.write(encode(msg));
      continue;
    }

    // --- Forward everything else to editor ---
    debug('VUE→ED', `${msg.method || 'response'} id=${msg.id || '-'}`);
    process.stdout.write(encode(msg));
  }
});

// =====================================================================
// TS LS → Multiplexer
// =====================================================================

tsLs.stdout.on('data', (chunk) => {
  tsBuffer = Buffer.concat([tsBuffer, chunk]);
  const { messages, remaining } = parseMessages(tsBuffer);
  tsBuffer = remaining;

  for (const raw of messages) {
    const msg = JSON.parse(raw);

    // --- Init response ---
    if (msg.id === tsInitId) {
      log('TS-INIT', 'ts-ls initialized');
      tsLs.stdin.write(encode({ jsonrpc: '2.0', method: 'initialized', params: {} }));
      tsInitialized = true;
      for (const q of tsInitQueue) sendTsServerCommand(q.vueRequestId, q.command, q.args);
      tsInitQueue = [];
      continue;
    }

    // --- tsserver/request proxy response → vue-ls ---
    if (msg.id !== undefined && tsProxyRequests.has(msg.id)) {
      const { vueRequestId } = tsProxyRequests.get(msg.id);
      tsProxyRequests.delete(msg.id);
      const body = extractTsResponseBody(msg.result);
      debug('TS→VUE', `tsserver/response vueId=${vueRequestId}`);
      vueLs.stdin.write(encode(buildTsServerResponse(vueRequestId, body)));
      continue;
    }

    // --- Fallback response → editor ---
    if (msg.id !== undefined && tsFallbackRequests.has(msg.id)) {
      const { editorId, method } = tsFallbackRequests.get(msg.id);
      tsFallbackRequests.delete(msg.id);
      debug('TS→ED', `${method} id=${editorId} (fallback)`);
      process.stdout.write(encode({ ...msg, id: editorId }));
      continue;
    }

    // --- TS diagnostics → forward to editor ---
    if (msg.method === 'textDocument/publishDiagnostics') {
      debug('TS→ED', `diagnostics ${msg.params.uri}`);
      process.stdout.write(encode(msg));
      continue;
    }

    // --- Ignore other ts-ls messages ---
    debug('TS:skip', `${msg.method || 'response'} id=${msg.id || '-'}`);
  }
});

// =====================================================================
// Initialize TypeScript Language Server
// =====================================================================

function initializeTs() {
  tsInitId = nextTsId++;

  // Resolve @vue/typescript-plugin from vue-language-server's bundled node_modules
  let pluginLocation = '';
  try {
    const vueLsBin = execSync(`${WHICH_CMD} vue-language-server`, { encoding: 'utf8' }).trim().split('\n')[0];
    // Follow symlinks to find actual module location
    const realBin = fs.realpathSync(vueLsBin);
    // Navigate: .../node_modules/.bin/vue-language-server → .../node_modules/@vue/language-server
    // Or: .../bin/vue-language-server → .../lib/node_modules/@vue/language-server
    const binDir = path.dirname(realBin);
    const candidates = [
      // realpath resolved to .../bin/vue-language-server.js → package root is ../
      path.resolve(binDir, '..', 'node_modules'),
      // npm global (Unix): .../lib/node_modules/@vue/language-server/node_modules
      path.resolve(binDir, '..', 'lib', 'node_modules', '@vue', 'language-server', 'node_modules'),
      // Symlink not resolved: .../bin/ → .../lib/node_modules/...
      path.resolve(binDir, '..', 'lib', 'node_modules', '@vue', 'language-server', 'node_modules'),
      // npm global (Windows): %APPDATA%/npm/node_modules/@vue/language-server/node_modules
      path.resolve(binDir, 'node_modules', '@vue', 'language-server', 'node_modules'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, '@vue', 'typescript-plugin'))) {
        pluginLocation = candidate;
        break;
      }
    }

    // Last resort: use require.resolve from the binary's directory
    if (!pluginLocation) {
      const resolved = execSync(
        `node -e "console.log(require.resolve('@vue/typescript-plugin/package.json'))"`,
        { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.resolve(binDir, '..', 'lib', 'node_modules') } }
      ).trim();
      pluginLocation = path.dirname(path.dirname(resolved));
    }
  } catch (e) {
    log('TS-INIT', `Cannot resolve plugin: ${e.message}`);
  }

  // Resolve tsserver.js path from initializationOptions or auto-detect
  let tsserverPath;
  const rootDir = capturedRootUri ? uriToPath(capturedRootUri) : process.cwd();

  if (capturedInitOptions && capturedInitOptions.typescript && capturedInitOptions.typescript.tsdk) {
    tsserverPath = path.resolve(rootDir, capturedInitOptions.typescript.tsdk, 'tsserver.js');
  }

  // Auto-detect if not provided or file doesn't exist
  if (!tsserverPath || !fs.existsSync(tsserverPath)) {
    const autoPath = path.resolve(rootDir, 'node_modules', 'typescript', 'lib', 'tsserver.js');
    if (fs.existsSync(autoPath)) {
      tsserverPath = autoPath;
    }
  }

  log('TS-INIT', `plugin=${pluginLocation}, tsserver=${tsserverPath || 'default'}`);

  tsLs.stdin.write(encode({
    jsonrpc: '2.0',
    id: tsInitId,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: capturedRootUri,
      workspaceFolders: capturedWorkspaceFolders,
      capabilities: capturedCapabilities || {},
      initializationOptions: {
        plugins: [{
          name: '@vue/typescript-plugin',
          languages: ['vue'],
          location: pluginLocation,
        }],
        tsserver: tsserverPath ? { path: tsserverPath } : undefined,
      },
    },
  }));
}

// =====================================================================
// tsserver/request proxy (vue-ls → ts-ls)
// =====================================================================

function handleTsServerRequest(params) {
  const { vueRequestId, command, args } = parseTsServerRequestParams(params);
  debug('TSREQ', `id=${vueRequestId} cmd=${command}`);

  if (!tsInitialized) {
    tsInitQueue.push({ vueRequestId, command, args });
    return;
  }

  sendTsServerCommand(vueRequestId, command, args);
}

function sendTsServerCommand(vueRequestId, command, args) {
  const id = nextTsId++;
  tsProxyRequests.set(id, { vueRequestId });
  tsLs.stdin.write(encode(buildTsServerCommand(id, command, args)));
}

// =====================================================================
// Shutdown
// =====================================================================

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('SHUTDOWN', 'Cleaning up');
  vueLs.kill();
  tsLs.kill();
  if (logStream) logStream.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
process.on('uncaughtException', (err) => {
  log('FATAL', err.stack || err.message);
  shutdown();
});
