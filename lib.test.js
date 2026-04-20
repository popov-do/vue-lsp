import { describe, it, expect } from 'vitest';
import {
  parseMessages, encode, isEmpty, uriToPath,
  routeRequest, parseTsServerRequestParams,
  extractTsResponseBody, buildTsServerResponse, buildTsServerCommand,
  TS_FALLBACK_METHODS, TS_ONLY_METHODS,
} from './lib.js';

// =============================================================
// parseMessages
// =============================================================

describe('parseMessages', () => {
  it('parses a single complete message', () => {
    const obj = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    const buf = encode(obj);
    const { messages, remaining } = parseMessages(buf);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual(obj);
    expect(remaining.length).toBe(0);
  });

  it('parses multiple messages in one buffer', () => {
    const msg1 = { jsonrpc: '2.0', id: 1, method: 'hover' };
    const msg2 = { jsonrpc: '2.0', id: 2, method: 'definition' };
    const buf = Buffer.concat([encode(msg1), encode(msg2)]);
    const { messages, remaining } = parseMessages(buf);
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[0])).toEqual(msg1);
    expect(JSON.parse(messages[1])).toEqual(msg2);
    expect(remaining.length).toBe(0);
  });

  it('handles incomplete message (partial body)', () => {
    const obj = { jsonrpc: '2.0', id: 1, method: 'test' };
    const full = encode(obj);
    const partial = full.slice(0, full.length - 5);
    const { messages, remaining } = parseMessages(partial);
    expect(messages).toHaveLength(0);
    expect(remaining.length).toBe(partial.length);
  });

  it('handles incomplete header (no \\r\\n\\r\\n)', () => {
    const buf = Buffer.from('Content-Length: 10\r\n');
    const { messages, remaining } = parseMessages(buf);
    expect(messages).toHaveLength(0);
    expect(remaining.length).toBe(buf.length);
  });

  it('handles empty buffer', () => {
    const { messages, remaining } = parseMessages(Buffer.alloc(0));
    expect(messages).toHaveLength(0);
    expect(remaining.length).toBe(0);
  });

  it('handles malformed header (no Content-Length)', () => {
    const buf = Buffer.from('Bad-Header: value\r\n\r\n{"id":1}');
    const { messages, remaining } = parseMessages(buf);
    expect(messages).toHaveLength(0);
    expect(remaining.length).toBe(buf.length);
  });

  it('handles one complete + one partial message', () => {
    const msg1 = { jsonrpc: '2.0', id: 1 };
    const msg2 = { jsonrpc: '2.0', id: 2, method: 'long-method-name' };
    const full2 = encode(msg2);
    const buf = Buffer.concat([encode(msg1), full2.slice(0, full2.length - 3)]);
    const { messages, remaining } = parseMessages(buf);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual(msg1);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('handles UTF-8 content correctly', () => {
    const obj = { text: 'ünïcödé 日本語' };
    const buf = encode(obj);
    const { messages } = parseMessages(buf);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual(obj);
  });
});

// =============================================================
// encode
// =============================================================

describe('encode', () => {
  it('produces valid Content-Length header', () => {
    const obj = { id: 1 };
    const buf = encode(obj);
    const str = buf.toString('utf8');
    expect(str).toMatch(/^Content-Length: \d+\r\n\r\n/);
  });

  it('Content-Length matches actual byte length', () => {
    const obj = { text: 'héllo wörld' };
    const buf = encode(obj);
    const str = buf.toString('utf8');
    const match = str.match(/Content-Length: (\d+)/);
    const len = parseInt(match[1]);
    const body = str.split('\r\n\r\n')[1];
    expect(Buffer.byteLength(body, 'utf8')).toBe(len);
  });

  it('round-trips with parseMessages', () => {
    const obj = { jsonrpc: '2.0', id: 42, result: { data: [1, 2, 3] } };
    const buf = encode(obj);
    const { messages } = parseMessages(buf);
    expect(JSON.parse(messages[0])).toEqual(obj);
  });
});

// =============================================================
// isEmpty
// =============================================================

describe('isEmpty', () => {
  it('returns true for null', () => expect(isEmpty(null)).toBe(true));
  it('returns true for undefined', () => expect(isEmpty(undefined)).toBe(true));
  it('returns true for empty array', () => expect(isEmpty([])).toBe(true));
  it('returns false for non-empty array', () => expect(isEmpty([1])).toBe(false));
  it('returns false for object', () => expect(isEmpty({ a: 1 })).toBe(false));
  it('returns false for zero', () => expect(isEmpty(0)).toBe(false));
  it('returns false for empty string', () => expect(isEmpty('')).toBe(false));
  it('returns false for false', () => expect(isEmpty(false)).toBe(false));
});

// =============================================================
// uriToPath
// =============================================================

describe('uriToPath', () => {
  it('converts Unix file URI', () => {
    expect(uriToPath('file:///home/user/project')).toBe('/home/user/project');
  });

  it('converts Windows file URI', () => {
    expect(uriToPath('file:///C:/Users/project', true)).toBe('C:\\Users\\project');
  });

  it('converts Windows URI with nested path', () => {
    expect(uriToPath('file:///D:/work/src/file.vue', true)).toBe('D:\\work\\src\\file.vue');
  });

  it('handles macOS path', () => {
    expect(uriToPath('file:///Users/dev/project')).toBe('/Users/dev/project');
  });
});

// =============================================================
// routeRequest
// =============================================================

describe('routeRequest', () => {
  it('routes initialize', () => {
    expect(routeRequest('initialize', 1)).toBe('initialize');
  });

  it('routes shutdown to both', () => {
    expect(routeRequest('shutdown', 1)).toBe('both');
  });

  it('routes exit to both', () => {
    expect(routeRequest('exit', undefined)).toBe('both');
  });

  it('routes didOpen to both', () => {
    expect(routeRequest('textDocument/didOpen', undefined)).toBe('both');
  });

  it('routes didChange to both', () => {
    expect(routeRequest('textDocument/didChange', undefined)).toBe('both');
  });

  it('routes didClose to both', () => {
    expect(routeRequest('textDocument/didClose', undefined)).toBe('both');
  });

  it('routes didSave to both', () => {
    expect(routeRequest('textDocument/didSave', undefined)).toBe('both');
  });

  describe('TS fallback methods', () => {
    for (const method of TS_FALLBACK_METHODS) {
      it(`routes ${method} with id to fallback`, () => {
        expect(routeRequest(method, 1)).toBe('fallback');
      });

      it(`routes ${method} without id to vue`, () => {
        expect(routeRequest(method, undefined)).toBe('vue');
      });
    }
  });

  describe('TS-only methods', () => {
    for (const method of TS_ONLY_METHODS) {
      it(`routes ${method} with id to ts-only`, () => {
        expect(routeRequest(method, 1)).toBe('ts-only');
      });
    }
  });

  it('routes documentSymbol to vue', () => {
    expect(routeRequest('textDocument/documentSymbol', 1)).toBe('vue');
  });

  it('routes formatting to vue', () => {
    expect(routeRequest('textDocument/formatting', 1)).toBe('vue');
  });

  it('routes unknown methods to vue', () => {
    expect(routeRequest('custom/method', 1)).toBe('vue');
  });
});

// =============================================================
// parseTsServerRequestParams
// =============================================================

describe('parseTsServerRequestParams', () => {
  it('parses nested array format [[id, cmd, args]]', () => {
    const result = parseTsServerRequestParams([[42, '_vue:projectInfo', { file: 'test.vue' }]]);
    expect(result).toEqual({
      vueRequestId: 42,
      command: '_vue:projectInfo',
      args: { file: 'test.vue' },
    });
  });

  it('parses flat array format [id, cmd, args]', () => {
    const result = parseTsServerRequestParams([7, '_vue:quickinfo', { line: 1 }]);
    expect(result).toEqual({
      vueRequestId: 7,
      command: '_vue:quickinfo',
      args: { line: 1 },
    });
  });
});

// =============================================================
// extractTsResponseBody
// =============================================================

describe('extractTsResponseBody', () => {
  it('extracts body from tsserver response', () => {
    const result = { seq: 0, type: 'response', body: { configFileName: '/tsconfig.json' } };
    expect(extractTsResponseBody(result)).toEqual({ configFileName: '/tsconfig.json' });
  });

  it('returns result as-is when no body field', () => {
    const result = { type: 'noServer' };
    expect(extractTsResponseBody(result)).toEqual({ type: 'noServer' });
  });

  it('handles null result', () => {
    expect(extractTsResponseBody(null)).toBe(null);
  });

  it('handles undefined result', () => {
    expect(extractTsResponseBody(undefined)).toBe(undefined);
  });

  it('handles body being null', () => {
    expect(extractTsResponseBody({ body: null })).toBe(null);
  });

  it('handles body being false', () => {
    expect(extractTsResponseBody({ body: false })).toBe(false);
  });
});

// =============================================================
// buildTsServerResponse
// =============================================================

describe('buildTsServerResponse', () => {
  it('builds correct notification format', () => {
    const resp = buildTsServerResponse(5, { configFileName: '/tsconfig.json' });
    expect(resp).toEqual({
      jsonrpc: '2.0',
      method: 'tsserver/response',
      params: [[5, { configFileName: '/tsconfig.json' }]],
    });
  });

  it('handles null body', () => {
    const resp = buildTsServerResponse(1, null);
    expect(resp.params).toEqual([[1, null]]);
  });
});

// =============================================================
// buildTsServerCommand
// =============================================================

describe('buildTsServerCommand', () => {
  it('builds correct executeCommand request', () => {
    const cmd = buildTsServerCommand(100, '_vue:projectInfo', { file: 'test.vue' });
    expect(cmd).toEqual({
      jsonrpc: '2.0',
      id: 100,
      method: 'workspace/executeCommand',
      params: {
        command: 'typescript.tsserverRequest',
        arguments: ['_vue:projectInfo', { file: 'test.vue' }],
      },
    });
  });
});

// =============================================================
// Method sets completeness
// =============================================================

describe('TS_FALLBACK_METHODS', () => {
  it('contains all expected hover/navigation methods', () => {
    expect(TS_FALLBACK_METHODS.has('textDocument/hover')).toBe(true);
    expect(TS_FALLBACK_METHODS.has('textDocument/definition')).toBe(true);
    expect(TS_FALLBACK_METHODS.has('textDocument/references')).toBe(true);
    expect(TS_FALLBACK_METHODS.has('textDocument/completion')).toBe(true);
    expect(TS_FALLBACK_METHODS.has('textDocument/rename')).toBe(true);
  });

  it('does not contain vue-only methods', () => {
    expect(TS_FALLBACK_METHODS.has('textDocument/documentSymbol')).toBe(false);
    expect(TS_FALLBACK_METHODS.has('textDocument/formatting')).toBe(false);
    expect(TS_FALLBACK_METHODS.has('textDocument/foldingRange')).toBe(false);
  });
});

describe('TS_ONLY_METHODS', () => {
  it('contains completionItem/resolve', () => {
    expect(TS_ONLY_METHODS.has('completionItem/resolve')).toBe(true);
  });

  it('contains workspace/symbol', () => {
    expect(TS_ONLY_METHODS.has('workspace/symbol')).toBe(true);
  });
});
