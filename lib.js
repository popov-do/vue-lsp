/**
 * Pure/testable functions extracted from the Vue LSP Multiplexer.
 */

// --- JSON-RPC message parsing ---

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

function uriToPath(uri, isWin = false) {
  if (isWin) {
    return uri.replace('file:///', '').replace(/\//g, '\\');
  }
  return uri.replace('file://', '');
}

// --- Routing ---

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

const TS_ONLY_METHODS = new Set([
  'completionItem/resolve',
  'workspace/symbol',
]);

/**
 * Determine where to route a request.
 * Returns: 'vue' | 'ts-only' | 'fallback' | 'both' | 'initialize'
 */
function routeRequest(method, id) {
  if (method === 'initialize') return 'initialize';
  if (method === 'shutdown' || method === 'exit') return 'both';

  if (method === 'textDocument/didOpen' ||
      method === 'textDocument/didChange' ||
      method === 'textDocument/didClose' ||
      method === 'textDocument/didSave') {
    return 'both';
  }

  if (TS_ONLY_METHODS.has(method) && id !== undefined) return 'ts-only';
  if (TS_FALLBACK_METHODS.has(method) && id !== undefined) return 'fallback';

  return 'vue';
}

/**
 * Parse tsserver/request params (handles both nested and flat format).
 * Returns { vueRequestId, command, args }
 */
function parseTsServerRequestParams(params) {
  let vueRequestId, command, args;
  if (Array.isArray(params[0])) {
    [vueRequestId, command, args] = params[0];
  } else {
    [vueRequestId, command, args] = params;
  }
  return { vueRequestId, command, args };
}

/**
 * Extract the body from a tsserver proxy response.
 * ts-ls returns { result: { body: ... } } for tsserver commands.
 */
function extractTsResponseBody(result) {
  if (result && result.body !== undefined) return result.body;
  return result;
}

/**
 * Build the tsserver/response notification to send back to vue-ls.
 */
function buildTsServerResponse(vueRequestId, body) {
  return {
    jsonrpc: '2.0',
    method: 'tsserver/response',
    params: [[vueRequestId, body]],
  };
}

/**
 * Build a workspace/executeCommand request for typescript.tsserverRequest.
 */
function buildTsServerCommand(id, command, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'workspace/executeCommand',
    params: {
      command: 'typescript.tsserverRequest',
      arguments: [command, args],
    },
  };
}

module.exports = {
  parseMessages,
  encode,
  isEmpty,
  uriToPath,
  routeRequest,
  parseTsServerRequestParams,
  extractTsResponseBody,
  buildTsServerResponse,
  buildTsServerCommand,
  TS_FALLBACK_METHODS,
  TS_ONLY_METHODS,
};
