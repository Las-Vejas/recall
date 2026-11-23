// OAuth 2.1 for the MCP endpoint, so AI apps (Claude, ChatGPT, …) can connect by signing in to Recall instead of
// pasting an API token. It follows the MCP authorization spec:
//   1. POST /mcp without a token answers 401 with WWW-Authenticate: Bearer resource_metadata="…".
//   2. The app reads /.well-known/oauth-protected-resource and /.well-known/oauth-authorization-server.
//   3. It registers itself at POST /oauth/register (dynamic client registration, public client, no secret).
//   4. It sends the user to /oauth/authorize (a page in the web app). They sign in and press Allow.
//   5. It trades the code at POST /oauth/token (PKCE S256 required) for an access token.
// The access token is an ordinary API token named after the app, so it shows up in Account > API tokens and
// is revoked there. It does not expire, the same as tokens made by hand.
import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import * as auth from './auth.js';

const CODE_TTL = 5 * 60_000;
const SCOPE = 'recall';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();

// authorization codes live for 5 minutes and are used once, so memory is enough
const codes = new Map();
function sweep() { for (const [k, c] of codes) if (c.expires < now()) codes.delete(k); }

/** https anywhere, or http on a loopback address (desktop and CLI apps listen there for the redirect). */
function okRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  // native apps may use a private scheme such as cursor://
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol);
}

export async function getClient(id) {
  const c = await db.get('SELECT * FROM oauth_clients WHERE id = ?', String(id || ''));
  return c && { id: c.id, name: c.name, redirectUris: JSON.parse(c.redirect_uris) };
}

const oauthError = (res, status, error, description) => res.status(status).json({ error, error_description: description });

/** Checks an authorization request from the consent page. Returns { client } or throws a user-facing error. */
export async function checkAuthorizeRequest(q) {
  const client = await getClient(q.client_id);
  if (!client) throw auth.userError('This app is not registered with Recall. Try connecting again from the app.');
  if (!client.redirectUris.includes(q.redirect_uri)) throw auth.userError('This app asked to return to an address it did not register.');
  if (q.response_type !== 'code') throw auth.userError('Unsupported response_type, only "code" is allowed.');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') throw auth.userError('This app did not send a PKCE S256 challenge.');
  return { client };
}

/** The user pressed Allow: mint a code and return where to send the browser. */
export async function approve(userId, q) {
  const { client } = await checkAuthorizeRequest(q);
  sweep();
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(sha(code), { clientId: client.id, userId, redirectUri: q.redirect_uri, challenge: q.code_challenge, expires: now() + CODE_TTL });
  const url = new URL(q.redirect_uri);
  url.searchParams.set('code', code);
  if (q.state) url.searchParams.set('state', q.state);
  return url.toString();
}

export function denyUrl(q) {
  const url = new URL(q.redirect_uri);
  url.searchParams.set('error', 'access_denied');
  if (q.state) url.searchParams.set('state', q.state);
  return url.toString();
}

/** Discovery, registration and token endpoints. `originOf(req)` gives this server's public origin. */
export function oauthRouter(originOf) {
  const r = express.Router();
  // public, cookie-free endpoints: any origin may call them (browser-based MCP clients do)
  r.use(['/.well-known', '/oauth/register', '/oauth/token'], (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  const resource = (req) => ({
    resource: `${originOf(req)}/mcp`,
    authorization_servers: [originOf(req)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Recall',
  });
  r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => res.json(resource(req)));

  const server = (req) => {
    const o = originOf(req);
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  };
  r.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], (req, res) => res.json(server(req)));

  // RFC 7591 dynamic client registration. Clients are public (PKCE, no secret).
  r.post('/oauth/register', async (req, res) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every((u) => u.length <= 500 && okRedirect(u))) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs, or http on localhost');
    }
    const name = String(b.client_name || 'AI app').replace(/\s+/g, ' ').trim().slice(0, 60) || 'AI app';
    const id = `rc_${crypto.randomBytes(16).toString('base64url')}`;
    const created = now();
    await db.run('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)', id, name, JSON.stringify(uris), created);
    res.status(201).json({
      client_id: id, client_id_issued_at: Math.floor(created / 1000), client_name: name, redirect_uris: uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: SCOPE,
    });
  });

  r.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    if (b.grant_type !== 'authorization_code') return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
    const key = sha(b.code || '');
    const c = codes.get(key);
    codes.delete(key); // one use, even when the rest of the request is wrong
    if (!c || c.expires < now()) return oauthError(res, 400, 'invalid_grant', 'The code is invalid or expired');
    if (c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'client_id or redirect_uri does not match');
    const verifier = String(b.code_verifier || '');
    if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE check failed');
    const client = await getClient(c.clientId);
    const user = await auth.getUser(c.userId);
    if (!client || !user) return oauthError(res, 400, 'invalid_grant', 'The app or account no longer exists');
    const { token } = await auth.createApiToken(user.id, client.name);
    console.log(`MCP: @${user.username} connected ${client.name}`);
    res.json({ access_token: token, token_type: 'Bearer', scope: SCOPE });
  });

  return r;
}
