#!/usr/bin/env node

/**
 * Vue LSP Multiplexer for Volar v3
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

// --- Logging (set VUE_LSP_DEBUG=1 for verbose) ---
const LOG_FILE = '/tmp/vue-lsp-wrapper.log';
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const DEBUG = process.env.VUE_LSP_DEBUG === '1';

function log(tag, msg) {
  logStream.write(`[${new Date().toISOString()}] [${tag}] ${msg}\n`);
}

function debug(tag, msg) {
  if (DEBUG) log(tag, msg);
}

log('INIT', `=== Vue LSP Multiplexer v1.0 === PID=${process.pid} CWD=${process.cwd()}`);

// --- Configuration ---
const VUE_LS_CMD = process.env.VUE_LS_CMD || 'vue-language-server';
const TS_LS_CMD = process.env.TS_LS_CMD || 'typescript-language-server';

// Requests: vue-ls first → ts-ls fallback if empty
const TS_FALLBACK_METHODS = new Set([
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/signatureHelp',
  'textDocument/codeAction',
  'textDocument/rename',
  'textDocument/prepareRename',
  'textDocument/completion',
  'textDocument/documentHighlight',
  'textDocument/prepareCallHierarchy',
  'callHierarchy/incomingCalls',
  'callHierarchy/outgoingCalls',
]);

// Requests: ts-ls only (vue-ls doesn't handle these)
const TS_ONLY_METHODS = new Set([
  'completionItem/resolve',
  'workspace/symbol',
]);

// --- JSON-RPC helpers ---

function parseMessages(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) break;

    const header = buffer.slice(offset, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;

    const contentLength = parseInt(match[1], 10);
    const contentStart = headerEnd + 4;
    const contentEnd = contentStart + contentLength;

    if (contentEnd > buffer.length) break;

    messages.push(buffer.slice(contentStart, contentEnd).toString('utf8'));
    offset = contentEnd;
  }

  return { messages, remaining: buffer.slice(offset) };
}

function encode(obj) {
  const content = JSON.stringify(obj);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(content, 'utf8')}\r\n\r\n${content}`, 'utf8');
}

function isEmpty(result) {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result) && result.length === 0) return true;
  return false;
}

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

    // --- Initialize ---
    if (method === 'initialize') {
      capturedRootUri = msg.params.rootUri;
      capturedWorkspaceFolders = msg.params.workspaceFolders;
      capturedInitOptions = msg.params.initializationOptions;
      capturedCapabilities = msg.params.capabilities;
      initializeTs();
      vueLs.stdin.write(encode(msg));
      continue;
    }

    // --- Shutdown/exit → both servers ---
    if (method === 'shutdown' || method === 'exit') {
      debug('ROUTE', `${method} → both`);
      vueLs.stdin.write(encode(msg));
      tsLs.stdin.write(encode(msg));
      if (method === 'exit') shutdown();
      continue;
    }

    // --- Document sync → both servers ---
    if (method === 'textDocument/didOpen' ||
        method === 'textDocument/didChange' ||
        method === 'textDocument/didClose' ||
        method === 'textDocument/didSave') {
      debug('ROUTE', `${method} → both`);
      vueLs.stdin.write(encode(msg));
      if (tsInitialized) tsLs.stdin.write(encode(msg));
      continue;
    }

    // --- TS-only → ts-ls directly ---
    if (TS_ONLY_METHODS.has(method) && id !== undefined) {
      debug('ROUTE', `${method} id=${id} → ts-ls only`);
      const tsId = nextTsId++;
      tsFallbackRequests.set(tsId, { editorId: id, method });
      tsLs.stdin.write(encode({ ...msg, id: tsId }));
      continue;
    }

    // --- TS fallback → vue-ls first, then ts-ls if empty ---
    if (TS_FALLBACK_METHODS.has(method) && id !== undefined) {
      debug('ROUTE', `${method} id=${id} → vue-ls (with ts fallback)`);
      pendingFallbacks.set(id, { method, params: msg.params });
      vueLs.stdin.write(encode(msg));
      continue;
    }

    // --- Everything else → vue-ls ---
    debug('ROUTE', `${method || 'response'} id=${id || '-'} → vue-ls`);
    vueLs.stdin.write(encode(msg));
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
      const body = msg.result && msg.result.body !== undefined ? msg.result.body : msg.result;
      debug('TS→VUE', `tsserver/response vueId=${vueRequestId}`);
      vueLs.stdin.write(encode({
        jsonrpc: '2.0',
        method: 'tsserver/response',
        params: [[vueRequestId, body]],
      }));
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
    const vueLsBin = execSync('which vue-language-server', { encoding: 'utf8' }).trim();
    pluginLocation = path.resolve(
      path.dirname(vueLsBin), '..', 'lib', 'node_modules',
      '@vue', 'language-server', 'node_modules'
    );
  } catch (e) {
    log('TS-INIT', `Cannot resolve plugin: ${e.message}`);
  }

  // Resolve tsserver.js path from initializationOptions.typescript.tsdk
  let tsserverPath;
  if (capturedInitOptions && capturedInitOptions.typescript && capturedInitOptions.typescript.tsdk) {
    tsserverPath = path.resolve(
      capturedRootUri.replace('file://', ''),
      capturedInitOptions.typescript.tsdk,
      'tsserver.js'
    );
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
  let vueRequestId, command, args;
  if (Array.isArray(params[0])) {
    [vueRequestId, command, args] = params[0];
  } else {
    [vueRequestId, command, args] = params;
  }

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

  tsLs.stdin.write(encode({
    jsonrpc: '2.0',
    id,
    method: 'workspace/executeCommand',
    params: {
      command: 'typescript.tsserverRequest',
      arguments: [command, args],
    },
  }));
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
  logStream.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
process.on('uncaughtException', (err) => {
  log('FATAL', err.stack || err.message);
  shutdown();
});
