// Identity providers (OAuth 2.0 / OpenID Connect), like Orchard's "Instance admin > Sign in".
// Presets: GitHub (OAuth 2.0), Google (OIDC). "oidc" works with any provider that has discovery
// (Authentik, Keycloak, Okta, Auth0, Entra ID, GitLab, Hack Club, …).
// One provider can also come from the environment (AUTH_OAUTH_*), which is read-only in the UI.
//
// Sign-in rules (same spirit as Orchard): a provider signs in the account it was *connected* to.
// It never attaches itself to an existing account by matching email. A new account is created only
// when the provider allows sign-up and the person has an invite link or open sign-up is on.
import crypto from 'node:crypto';
import { db } from './db.js';
import { sign, unsign, userError, getUser, freeUsername, createUser, createSession, inviteByToken, useInvite, openSignup, cookieSecure } from './auth.js';

const PRESETS = {
  github: { name: 'GitHub', authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scopes: 'read:user user:email' },
  google: { name: 'Google', issuer: 'https://accounts.google.com', scopes: 'openid profile email' },
  oidc: { name: 'OpenID Connect', scopes: 'openid profile email' },
};
export const PROVIDER_TYPES = Object.keys(PRESETS);
const FLOW = 'recall_oauth';

// ---------------- provider config ----------------
function envProvider() {
  const e = process.env;
  if (!e.AUTH_OAUTH_CLIENT_ID) return null;
  return {
    id: 'sso', type: 'oidc', name: e.AUTH_OAUTH_NAME || 'Single sign-on', fromEnv: true,
    client_id: e.AUTH_OAUTH_CLIENT_ID, client_secret: e.AUTH_OAUTH_CLIENT_SECRET || '',
    issuer: e.AUTH_OAUTH_ISSUER || '', scopes: e.AUTH_OAUTH_SCOPES || 'openid profile email',
    authorize_url: e.AUTH_OAUTH_AUTHORIZE_URL, token_url: e.AUTH_OAUTH_TOKEN_URL, userinfo_url: e.AUTH_OAUTH_USERINFO_URL,
    allow_signup: e.AUTH_OAUTH_ALLOW_SIGNUP === 'true' ? 1 : 0, enabled: 1,
  };
}

export async function listProviders({ includeDisabled = false } = {}) {
  const rows = await db.all('SELECT * FROM auth_providers ORDER BY created_at');
  const all = [...(envProvider() ? [envProvider()] : []), ...rows];
  return includeDisabled ? all : all.filter((p) => p.enabled);
}
export async function getProvider(id) {
  if (id === 'sso' && envProvider()) return envProvider();
  return db.get('SELECT * FROM auth_providers WHERE id = ?', id);
}
/** What the browser may see about a provider (never the secret). */
export const publicProvider = (p) => ({
  id: p.id, type: p.type, name: p.name, issuer: p.issuer, scopes: p.scopes, clientId: p.client_id,
  allowSignup: !!p.allow_signup, enabled: !!p.enabled, fromEnv: !!p.fromEnv, hasSecret: !!p.client_secret,
});

export async function saveProvider(input, existingId) {
  if (existingId === 'sso') throw userError('This provider is set by environment variables');
  const existing = existingId ? await getProvider(existingId) : null;
  if (existingId && !existing) throw userError('Provider not found', 404);
  if (existing) {
    // an edit only changes the fields it sends
    input = {
      name: existing.name, issuer: existing.issuer, clientId: existing.client_id, scopes: existing.scopes,
      allowSignup: !!existing.allow_signup, enabled: !!existing.enabled, ...input,
    };
  }
  const type = existing ? existing.type : input.type;
  if (!PRESETS[type]) throw userError('Unknown provider type');
  const name = String(input.name || PRESETS[type].name).trim().slice(0, 40);
  const issuer = type === 'oidc' ? String(input.issuer || '').trim().replace(/\/+$/, '') : '';
  if (type === 'oidc' && !/^https?:\/\//.test(issuer)) throw userError('OpenID Connect needs an issuer URL, e.g. https://auth.example.com/application/o/recall');
  const fields = {
    name, issuer,
    client_id: String(input.clientId ?? '').trim(),
    scopes: String(input.scopes || PRESETS[type].scopes).trim(),
    allow_signup: input.allowSignup ? 1 : 0,
    enabled: input.enabled === false ? 0 : 1,
  };
  if (!fields.client_id) throw userError('Client ID is required');
  if (existingId) {
    for (const [k, v] of Object.entries(fields)) await db.run(`UPDATE auth_providers SET ${k} = ? WHERE id = ?`, v, existingId);
    if (input.clientSecret) await db.run('UPDATE auth_providers SET client_secret = ? WHERE id = ?', String(input.clientSecret).trim(), existingId);
    return getProvider(existingId);
  }
  if (!input.clientSecret) throw userError('Client secret is required');
  // id is used in the callback URL, so keep it short and stable
  let id = type === 'oidc' ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'oidc' : type;
  if (await getProvider(id)) id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  await db.run(`INSERT INTO auth_providers (id, type, name, client_id, client_secret, issuer, scopes, allow_signup, enabled, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, id, type, fields.name, fields.client_id, String(input.clientSecret).trim(), fields.issuer, fields.scopes, fields.allow_signup, fields.enabled, Date.now());
  return getProvider(id);
}
export async function deleteProvider(id) {
  if (id === 'sso') throw userError('This provider is set by environment variables');
  await db.run('DELETE FROM auth_providers WHERE id = ?', id);
}

// ---------------- endpoints (discovery cached) ----------------
const discovery = new Map();
async function endpoints(p) {
  if (p.type === 'github') return { authorize: PRESETS.github.authorize, token: PRESETS.github.token };
  if (p.authorize_url) return { authorize: p.authorize_url, token: p.token_url, userinfo: p.userinfo_url };
  const issuer = p.type === 'google' ? PRESETS.google.issuer : p.issuer;
  let doc = discovery.get(issuer);
  if (!doc || doc.at < Date.now() - 3_600_000) {
    const r = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw userError(`Could not read ${issuer}/.well-known/openid-configuration (HTTP ${r.status})`, 502);
    doc = { ...(await r.json()), at: Date.now() };
    discovery.set(issuer, doc);
  }
  return { authorize: doc.authorization_endpoint, token: doc.token_endpoint, userinfo: doc.userinfo_endpoint };
}

export const callbackUrl = (origin, id) => `${origin}/api/auth/oauth/${id}/callback`;

/** Step 1: send the browser to the provider. mode = login | link. */
export async function startFlow(req, res, origin, { providerId, mode, inviteToken, userId }) {
  const p = await getProvider(providerId);
  if (!p || !p.enabled) throw userError('That sign-in provider is not available', 404);
  const ep = await endpoints(p);
  const state = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  res.cookie(FLOW, sign({ state, verifier, providerId, mode, inviteToken: inviteToken || null, userId: userId || null, exp: Date.now() + 10 * 60_000 }),
    { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60_000, path: '/api/auth/oauth', secure: cookieSecure(req) });
  const url = new URL(ep.authorize);
  url.searchParams.set('client_id', p.client_id);
  url.searchParams.set('redirect_uri', callbackUrl(origin, p.id));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', p.scopes || PRESETS[p.type].scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (mode === 'link' || p.type === 'google') url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
}

async function fetchProfile(p, ep, accessToken) {
  const auth = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Recall' };
  if (p.type === 'github') {
    const u = await (await fetch('https://api.github.com/user', { headers: auth })).json();
    let email = u.email;
    let verified = false;
    try {
      const emails = await (await fetch('https://api.github.com/user/emails', { headers: auth })).json();
      const primary = Array.isArray(emails) && (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified));
      if (primary) { email = primary.email; verified = true; }
    } catch { /* scope not granted */ }
    if (!u.id) throw userError('GitHub did not return a profile', 502);
    return { subject: String(u.id), email: email || '', emailVerified: verified, name: u.name || u.login, username: u.login };
  }
  if (!ep.userinfo) throw userError('This provider has no userinfo endpoint', 502);
  const u = await (await fetch(ep.userinfo, { headers: auth })).json();
  if (!u.sub) throw userError('The provider did not return a user id (sub)', 502);
  return {
    subject: String(u.sub), email: u.email || '', emailVerified: u.email_verified === true || u.email_verified === 'true',
    name: u.name || [u.given_name, u.family_name].filter(Boolean).join(' ') || u.preferred_username || '',
    username: u.preferred_username || u.nickname || (u.email || '').split('@')[0],
  };
}

/** Step 2: provider redirected back. Returns where to send the browser. */
export async function finishFlow(req, res, origin, providerId, currentUser) {
  const flow = unsign(req.cookies?.[FLOW]);
  res.clearCookie(FLOW, { path: '/api/auth/oauth' });
  const back = (path, error) => (error ? `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}` : path);
  const failTo = flow?.mode === 'link' ? '/account/connections' : '/login';
  try {
    if (!flow || flow.providerId !== providerId || req.query.state !== flow.state) throw userError('Sign-in expired or was started in another tab. Please try again.');
    if (req.query.error) throw userError(String(req.query.error_description || req.query.error));
    const p = await getProvider(providerId);
    if (!p || !p.enabled) throw userError('That sign-in provider is not available');
    const ep = await endpoints(p);

    const tokenRes = await fetch(ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: callbackUrl(origin, p.id),
        client_id: p.client_id, client_secret: p.client_secret, code_verifier: flow.verifier,
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tok.access_token) throw userError(`${p.name} did not return a token${tok.error ? ` (${tok.error_description || tok.error})` : ''}`);
    const profile = await fetchProfile(p, ep, tok.access_token);
    const linked = await db.get('SELECT * FROM identities WHERE provider = ? AND subject = ?', p.id, profile.subject);

    // connect this identity to the signed-in account
    if (flow.mode === 'link') {
      if (!currentUser || currentUser.id !== flow.userId) throw userError('Sign in first, then connect the provider from Account settings');
      if (linked && linked.user_id !== currentUser.id) throw userError(`That ${p.name} account is already connected to a different Recall account`);
      if (!linked) {
        await db.run('INSERT INTO identities (user_id, provider, subject, email, username, created_at) VALUES (?,?,?,?,?,?)',
          currentUser.id, p.id, profile.subject, profile.email, profile.username || '', Date.now());
      }
      return '/account/connections?connected=' + encodeURIComponent(p.name);
    }

    // sign in with an already-connected identity
    if (linked) {
      await db.run('UPDATE identities SET email = ?, username = ? WHERE id = ?', profile.email, profile.username || '', linked.id);
      await createSession(req, res, linked.user_id, p.name);
      return '/';
    }

    // new person: only with sign-up allowed on this provider, plus an invite or open sign-up
    const invite = await inviteByToken(flow.inviteToken);
    if (!p.allow_signup || (!invite && !openSignup())) {
      throw userError(`No Recall account is connected to this ${p.name} account. Sign in another way and connect it in Account settings${invite ? '' : ', or ask for an invite'}.`);
    }
    if (!profile.email || !profile.emailVerified) throw userError(`${p.name} did not share a verified email address, which a new account needs`);
    if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', profile.email.toLowerCase())) {
      throw userError(`An account with ${profile.email} already exists. Sign in to it, then connect ${p.name} in Account settings.`);
    }
    const user = await db.tx(async () => {
      const u = await createUser({ username: await freeUsername(profile.username || profile.name), email: profile.email, name: profile.name, isAdmin: !!invite?.is_admin });
      await db.run('INSERT INTO identities (user_id, provider, subject, email, username, created_at) VALUES (?,?,?,?,?,?)',
        u.id, p.id, profile.subject, profile.email, profile.username || '', Date.now());
      if (invite) await useInvite(invite.id, u.id);
      return u;
    });
    await createSession(req, res, user.id, p.name);
    return '/?welcome=1';
  } catch (e) {
    if (!e.expected) console.error('OAuth error:', e);
    return back(failTo, e.expected ? e.message : 'Sign-in failed. Check the provider settings and try again.');
  }
}

export async function listIdentities(userId) {
  const rows = await db.all('SELECT id, provider, email, username, created_at FROM identities WHERE user_id = ? ORDER BY created_at', userId);
  const providers = new Map((await listProviders({ includeDisabled: true })).map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, providerName: providers.get(r.provider)?.name || r.provider, providerType: providers.get(r.provider)?.type || 'oidc' }));
}
export async function unlinkIdentity(userId, id, methodCount) {
  if (methodCount <= 1) throw userError('This is your only way to sign in. Add a passkey or password first.');
  await db.run('DELETE FROM identities WHERE user_id = ? AND id = ?', userId, id);
}
export { getUser };
