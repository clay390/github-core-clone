// HTTP wiring: one server, four surfaces over one store.
//
//   GET  /healthz                                   no auth, {"ok":true}
//   GET  /<owner>/<repo>.git/info/refs              smart-HTTP advertisements (v0/v2)
//   POST /<owner>/<repo>.git/git-upload-pack        v0 fetch / v2 ls-refs+fetch
//   POST /<owner>/<repo>.git/git-receive-pack       v0 push
//   *    /api/v3/...                                REST v3
//   POST /api/graphql                               GraphQL v4 (single op or batch)
//   POST /mcp                                       MCP over Streamable HTTP
//
// Auth: the shop token is the env's secret and is never handed to the entry, so any
// non-empty `Authorization: Bearer <token>` is the viewer (adaiversen); a missing header is
// a 401 on every authenticated surface. Every reply carries a deterministic
// `X-GitHub-Request-Id` (a per-process counter) and is JSON except the git byte streams.
// A malformed request body never crashes the server: it answers 400 and keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, mcpParseErrorBody } from './mcp.ts';
import { handleReceivePack, handleUploadPack, v0Advertisement, v2Advertisement } from './gitproto.ts';

const MAX_BODY_BYTES = 512 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * The shop token when the trial hands it to the entry (the starter README says it is in the
 * entry's environment). With it, a wrong bearer token is a 401 like a missing one; without it
 * the entry cannot tell right from wrong, so any non-empty bearer token is the viewer.
 */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function createApp(store: Store = new Store()): Server {
  let requestSeq = 0;

  const sendJson = (res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-GitHub-Request-Id': `req-${requestSeq}`,
      ...extraHeaders,
    });
    res.end(body);
  };

  const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void => {
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'X-GitHub-Request-Id': `req-${requestSeq}`,
      ...extraHeaders,
    });
    res.end(body);
  };

  const bearerToken = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/.exec(header.trim());
    if (match === null) return null;
    const token = match[1] as string;
    if (SHOP_TOKEN !== '' && token !== SHOP_TOKEN) return null;
    return token;
  };

  const server = createServer((req, res) => {
    requestSeq += 1;
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } else {
          res.end();
        }
      }
    })();
  });

  server.on('clientError', (err: Error, socket: import('node:net').Socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 32\r\n\r\n{"message":"Bad Request"}');
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (gitMatch !== null) {
      if (bearerToken(req) === null) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const owner = gitMatch[1] as string;
      const repoName = gitMatch[2] as string;
      const action = gitMatch[3] as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET' && action === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'Missing service parameter' });
          return;
        }
        const isV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
        const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
        sendBuffer(res, 200, body, `application/x-${service}-advertisement`);
        return;
      }
      if (method === 'POST' && action === 'git-upload-pack') {
        const body = await readBody(req);
        const isV2 = req.headers['git-protocol'] === 'version=2';
        try {
          sendBuffer(res, 200, handleUploadPack(repo, body, isV2), 'application/x-git-upload-pack-result');
        } catch (err) {
          process.stderr.write(`[git] upload-pack failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          sendBuffer(res, 400, Buffer.alloc(0), 'application/x-git-upload-pack-result');
        }
        return;
      }
      if (method === 'POST' && action === 'git-receive-pack') {
        const body = await readBody(req);
        try {
          sendBuffer(res, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result');
        } catch (err) {
          process.stderr.write(`[git] receive-pack failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          sendBuffer(res, 400, Buffer.alloc(0), 'application/x-git-receive-pack-result');
        }
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // ---- REST v3
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (bearerToken(req) === null) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((part) => part !== '');
      let body: unknown = null;
      if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw.toString('utf8'));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        body = parsed.value;
      }
      const host = req.headers.host ?? '127.0.0.1';
      const origin = `http://${host}`;
      const result = handleRest(store, method, segments, url.searchParams, body, origin);
      sendJson(res, result.status, result.body, result.headers ?? {});
      return;
    }

    // ---- GraphQL v4
    if (pathname === '/api/graphql') {
      if (bearerToken(req) === null) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw.toString('utf8'));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      sendJson(res, 200, handleGraphQL(store, parsed.value));
      return;
    }

    // ---- MCP
    if (pathname === '/mcp') {
      if (bearerToken(req) === null) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw.toString('utf8'));
      if (!parsed.ok) {
        sendJson(res, 400, mcpParseErrorBody());
        return;
      }
      const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
      const result = handleMcp(store, parsed.value, sessionId);
      if (result.json === null) {
        res.writeHead(result.status, { 'X-GitHub-Request-Id': `req-${requestSeq}` });
        res.end();
        return;
      }
      sendJson(res, result.status, result.json, result.sessionId !== undefined ? { 'Mcp-Session-Id': result.sessionId } : {});
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return server;
}
