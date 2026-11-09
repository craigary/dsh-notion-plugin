import z from '@deepseek-ai/schemastery';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Notion workspace plugin for DeepSeek Harness.
 *
 * Provides:
 * 1. 12 Notion skills from the official Notion Cookbook
 * 2. A Notion MCP connection using the MCP OAuth 2.0 authorization-code flow
 *    (PKCE), reached through a local authenticated proxy so the MCP client
 *    only ever sees a stable loopback URL.
 *
 * Authentication model
 * --------------------
 * Notion's hosted MCP server (https://mcp.notion.com/mcp) requires OAuth. The
 * DSH MCP client only supports static `headers`, so this plugin:
 *   - runs the OAuth authorization-code + PKCE flow on a fixed local port
 *     (http://localhost:53682/callback), exchanging the code for tokens and
 *     storing them as a credential record;
 *   - exposes a local proxy route that the MCP client is configured to talk to;
 *     the proxy injects a fresh `Authorization: Bearer <access_token>` on every
 *     forwarded request, refreshing the token when it is near expiry.
 */

export const name = 'dsh-notion-plugin';

// Services we use when present. All are optional so the bundle still loads in a
// profile that does not compose them; the matching capability degrades.
export const inject = ['skills', 'commands', 'credentials', 'authorization', 'tools'];

export const Config = z.object({
  redirectUri: z.string().default('http://localhost:53682/callback')
    .description('OAuth redirect URI used with the dynamically registered client'),
  registrationEndpoint: z.string().default('https://mcp.notion.com/register')
    .description('Dynamic client registration endpoint (RFC 7591)'),
  authorizationEndpoint: z.string().default('https://mcp.notion.com/authorize'),
  tokenEndpoint: z.string().default('https://mcp.notion.com/token'),
  scopes: z.string().default('default'),
  clientName: z.string().default('DSH Connector')
    .description('client_name sent during dynamic client registration'),
  clientUri: z.string().default('https://github.com/makenotion/claude-code-notion-plugin')
    .description('client_uri sent during dynamic client registration'),
  notionMcpUrl: z.string().default('https://mcp.notion.com/mcp')
    .description('Upstream Notion MCP endpoint the local proxy forwards to'),
  callbackPort: z.number().default(53682),
  callbackPath: z.string().default('/callback'),
  proxyPort: z.number().default(53683),
  apiPort: z.number().default(53684),
});

// ---------------------------------------------------------------------------
// Skill loading (unchanged behaviour)
// ---------------------------------------------------------------------------

function parseSkillMarkdown(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) return null;
  const yaml = match[1];
  const content = match[2].trim();
  const nameMatch = /^name:\s*(.+)$/m.exec(yaml);
  const descMatch = /^description:\s*([^\r\n]+(?:\r?\n(?!\w+:)[^\r\n]+)*)/m.exec(yaml);
  if (!nameMatch) return null;
  const skillName = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
  const description = descMatch ? descMatch[1].trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ') : '';
  return { name: skillName, description, content };
}


// Display metadata for the settings UI (ChatGPT-style short titles + subtitles).
// Keyed by canonical skill name; falls back to a derived title when absent.
const SKILL_DISPLAY = {
  'notion-build-my-engineering-wiki': { title: 'Build my engineering wiki', short: 'Bring technical docs and projects together' },
  'notion-create-my-team-handbook': { title: 'Create my team handbook', short: 'Organize team knowledge and procedures' },
  'notion-database-designer': { title: 'Database designer', short: 'Turn notes, images, and data into trackers, galleries, and charts.' },
  'notion-knowledge-capture': { title: 'Knowledge capture', short: 'Turn conversations into reusable docs' },
  'notion-meeting-intelligence': { title: 'Meeting prep', short: 'Prepare meetings and follow-ups' },
  'notion-organize-my-semester': { title: 'Organize my semester', short: 'Keep courses, notes, and deadlines together' },
  'notion-plan-marketing-campaigns': { title: 'Plan marketing campaigns', short: 'Organize campaigns, content, and production' },
  'notion-research-documentation': { title: 'Research documentation', short: 'Research and write cited docs' },
  'notion-set-up-my-project': { title: 'Set up my project', short: 'Create a project home with tasks and docs' },
  'notion-setup': { title: 'Set up Notion', short: 'Connect Notion and get started' },
  'notion-spec-to-implementation': { title: 'Spec to implementation', short: 'Turn specs into plans and tasks' },
  'notion-weekly-project-digest': { title: 'Weekly project digest', short: 'Summarize progress, blockers, and next steps' },
};

function skillDisplayTitle(name) {
  if (SKILL_DISPLAY[name]) return SKILL_DISPLAY[name].title;
  const base = name.replace(/^notion-/, '').replace(/-/g, ' ');
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}
function skillDisplayShort(name, fallback) {
  return (SKILL_DISPLAY[name] && SKILL_DISPLAY[name].short) || fallback;
}

export async function apply(ctx, config = {}) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const skillsDir = join(__dirname, 'skills');
  const cfg = config || {};
  // Last page requested via notion_open_page. Stored on globalThis so it is
  // shared across plugin generations in the same process (a reloaded fiber's
  // tool and the older HTTP server then see the same value).
  const OPEN_PAGE_KEY = '__dshNotionOpenPage';
  const getOpenPage = () => globalThis[OPEN_PAGE_KEY];
  const setOpenPage = (v) => { globalThis[OPEN_PAGE_KEY] = v; };

  // Last Notion page the plugin opened in the sidebar browser. The agent reads
  // this via notion_current_page to know which page the user is looking at.
  const LAST_URL_KEY = '__dshNotionLastUrl';
  const getLastUrl = () => globalThis[LAST_URL_KEY];
  const setLastUrl = (v) => { globalThis[LAST_URL_KEY] = v; };

  // Extract a Notion page id (32 hex chars, dashes optional) from a URL/string.
  const parseNotionId = (src) => {
    const m = String(src || '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
    if (!m) return undefined;
    const id = m[0];
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  };

  // ---- 1. Skills -----------------------------------------------------------
  // Skills are registered individually so a settings UI can enable/disable each
  // one (controlling modelInvocable) at runtime.
  const skillDefs = [];        // loaded definitions
  const skillDisposers = new Map(); // name -> disposer (registration)
  const disabledSkills = new Set(); // persisted disable-list

  function collectSkillDefs() {
    const defs = [];
    if (!existsSync(skillsDir)) return defs;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const parsed = parseSkillMarkdown(readFileSync(skillPath, 'utf8'));
      if (!parsed) continue;
      defs.push({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        resourceBase: { kind: 'directory', path: join(skillsDir, entry.name) },
      });
    }
    return defs;
  }

  function registerSkill(def) {
    const enabled = !disabledSkills.has(def.name);
    const disposer = ctx.skills.register({
      name: def.name,
      description: def.description,
      content: def.content,
      source: 'bundled',
      resourceBase: def.resourceBase,
      invocation: { modelInvocable: enabled, userInvocable: true },
    });
    skillDisposers.set(def.name, disposer);
  }

  function unregisterSkill(def) {
    const d = skillDisposers.get(def.name); if (d) { try { d(); } catch { /* ignore */ } skillDisposers.delete(def.name); }
  }

  function applySkillRegistrations() {
    if (!ctx.skills) return;
    for (const def of skillDefs) {
      unregisterSkill(def);
      registerSkill(def);
    }
  }

  async function setSkillEnabled(name, enabled) {
    // Normalize: operate on the canonical notion- prefixed name.
    const canonical = name.startsWith('notion-') ? name : `notion-${name}`;
    if (enabled) { disabledSkills.delete(canonical); disabledSkills.delete(canonical.slice(7)); }
    else { disabledSkills.add(canonical); }
    applySkillRegistrations();
    await writeRecordSafe('notion/skills', { v: 1, disabled: [...disabledSkills] }).catch(() => undefined);
  }

  // ---- 2. OAuth state machine + credential storage -------------------------
  const state = {
    pending: new Map(), // oauth state -> { verifier, createdAt }
  };

  const credentials = ctx.get?.('credentials');
  const timer = ctx.get?.('timer');

  // The credentials store addresses records by `<owner>/<id>`; a key without a
  // slash makes the whole document invalid and fails the next boot, so every key
  // here MUST contain exactly one `/`.
  const clientKey = 'notion/client';
  const accountsKey = 'notion/accounts';

  // Round-trip through JSON to guarantee the payload survives the store's JSON
  // round-trip check (drops undefined/functions). The store keeps it verbatim.
  function toJsonPayload(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
  }

  async function readRecordSafe(key) {
    if (!credentials) return undefined;
    try {
      const rec = await credentials.readRecord(key);
      if (!rec || rec.kind !== 'grant') return undefined;
      return rec.payload;
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-notion-plugin] Failed reading credential record ${key}: ${e?.message || e}`);
      return undefined;
    }
  }

  async function writeRecordSafe(key, payload) {
    if (!credentials) throw new Error('credentials service unavailable');
    const clean = toJsonPayload(payload);
    await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: clean }));
    return clean;
  }

  // ---- account store: { v:1, activeId, accounts: Account[] } ---
  // Account = { id, email, user_id, workspace_id, workspace_name, workspace_icon,
  //             access_token, refresh_token, token_type, scope, expires_at, obtained_at }
  async function readAccounts() {
    const rec = await readRecordSafe(accountsKey);
    if (!rec || !Array.isArray(rec.accounts)) return { v: 1, activeId: undefined, accounts: [] };
    // Defensive: drop any malformed entries rather than crash.
    const accounts = rec.accounts.filter((a) => a && typeof a === 'object' && a.id && a.access_token);
    return { v: 1, activeId: rec.activeId, accounts };
  }

  async function writeAccounts(store) {
    return writeRecordSafe(accountsKey, { v: 1, activeId: store.activeId, accounts: store.accounts || [] });
  }

  function activeAccount(store) {
    if (!store || !store.accounts.length) return undefined;
    return store.accounts.find((a) => a.id === store.activeId) || store.accounts[0];
  }

  // Upsert by id (workspace_id preferred, else user_id, else email). Re-authorizing
  // the same workspace refreshes its tokens in place instead of adding a duplicate.
  async function upsertAccount(account) {
    const store = await readAccounts();
    const idx = store.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) store.accounts[idx] = { ...store.accounts[idx], ...account };
    else store.accounts.push(account);
    store.activeId = account.id;
    await writeAccounts(store);
    return account;
  }

  async function setActiveAccount(id) {
    const store = await readAccounts();
    if (store.accounts.some((a) => a.id === id)) {
      store.activeId = id;
      await writeAccounts(store);
    }
    return store;
  }

  async function removeAccount(id) {
    const store = await readAccounts();
    store.accounts = store.accounts.filter((a) => a.id !== id);
    if (store.activeId === id) store.activeId = store.accounts[0]?.id;
    await writeAccounts(store);
    return store;
  }

  async function readClient() {
    return readRecordSafe(clientKey);
  }

  async function writeClient(payload) {
    return writeRecordSafe(clientKey, payload);
  }

  async function registerClient() {
    const body = {
      client_name: cfg.clientName,
      client_uri: cfg.clientUri,
      redirect_uris: [cfg.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: cfg.scopes,
    };
    const res = await fetch(cfg.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!res.ok || !json || !json.client_id) {
      const detail = json?.error_description || json?.error || text.slice(0, 300);
      throw new Error(`Dynamic client registration failed (${res.status}): ${detail}`);
    }
    const client = {
      client_id: json.client_id,
      client_secret: json.client_secret || undefined,
      token_endpoint_auth_method: 'none',
      registered_at: nowSec(),
    };
    await writeClient(client);
    ctx.logger?.info?.(`[dsh-notion-plugin] Registered MCP client ${client.client_id}`);
    return client;
  }

  async function ensureClient() {
    return (await readClient()) || (await registerClient());
  }

  function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function pkcePair() {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  async function exchangeToken(params) {
    const client = await ensureClient();
    const body = new URLSearchParams(params);
    body.set('client_id', client.client_id);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (client.client_secret) {
      // client_secret_basic; Notion rejects mixing methods, so drop body client_id/secret
      const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }
    const res = await fetch(cfg.tokenEndpoint, { method: 'POST', headers, body });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!res.ok || !json || !json.access_token) {
      const code = json?.error;
      const detail = json?.error_description || code || text.slice(0, 300);
      const err = new Error(`Token endpoint returned ${res.status}: ${detail}`);
      err.oauthError = code;
      throw err;
    }
    return json;
  }

  function accountIdFrom(json) {
    return json.workspace_id || json.user_id || json.bot_id || json.email_domain || 'default';
  }

  function normalizeTokens(json) {
    return {
      id: accountIdFrom(json),
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      token_type: json.token_type || 'Bearer',
      scope: json.scope || cfg.scopes,
      expires_at: json.expires_in ? nowSec() + Number(json.expires_in) : undefined,
      obtained_at: nowSec(),
      // identity fields from the authorization-code exchange (kept for display)
      workspace_id: json.workspace_id,
      workspace_name: json.workspace_name,
      workspace_icon: json.workspace_icon,
      user_id: json.user_id,
      email_domain: json.email_domain,
    };
  }

  // Returns a valid access token for the given account (or the active one when
  // no id is given), refreshing if needed and persisting rotated tokens back.
  async function ensureFreshTokenFor(accountId) {
    const store = await readAccounts();
    const acc = (accountId && store.accounts.find((a) => a.id === accountId)) || activeAccount(store);
    if (!acc || !acc.access_token) return undefined;
    const skew = 120; // refresh 2 minutes before expiry to avoid races
    if (acc.expires_at && acc.expires_at - skew > nowSec()) return acc;
    if (!acc.refresh_token) {
      return acc; // cannot refresh; let the upstream 401 drive re-auth
    }
    try {
      const json = await exchangeToken({
        grant_type: 'refresh_token',
        refresh_token: acc.refresh_token,
      });
      const patch = normalizeTokens(json);
      // Notion rotates refresh tokens; persist atomically into the same account.
      const merged = {
        ...acc,
        ...patch,
        id: acc.id,
        refresh_token: json.refresh_token || acc.refresh_token,
        workspace_name: acc.workspace_name || patch.workspace_name,
        workspace_icon: acc.workspace_icon || patch.workspace_icon,
      };
      await upsertAccount(merged);
      return merged;
    } catch (e) {
      if (e.oauthError === 'invalid_grant') {
        // This grant is dead; drop just this account so others keep working.
        await removeAccount(acc.id);
        ctx.logger?.warn?.(`[dsh-notion-plugin] Notion account ${acc.id} grant invalid; removed, re-authorization required.`);
        return undefined;
      }
      throw e;
    }
  }

  async function ensureFreshToken() {
    return ensureFreshTokenFor(undefined);
  }

  // Call notion-get-self directly against the upstream MCP endpoint using a
  // bearer token, to read the connected person's email and workspace identity.
  async function fetchNotionSelf(token) {
    const post = async (body, sid) => {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      };
      if (sid) headers['mcp-session-id'] = sid;
      const res = await fetch(cfg.notionMcpUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      return res;
    };
    const initRes = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-notion-plugin', version: '1.0' } } });
    const sid = initRes.headers.get('mcp-session-id') || undefined;
    const initText = await initRes.text();
    if (!initRes.ok) throw new Error(`initialize ${initRes.status}`);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid).catch(() => {});
    const callRes = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notion-get-self', arguments: {} } }, sid);
    const text = await callRes.text();
    // SSE frames: lines starting with "data: {json}"
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    const content = payload?.result?.content?.[0]?.text;
    if (!content) return undefined;
    return JSON.parse(content);
  }

  /**
   * Call one Notion MCP tool with the given access token (JSON-RPC over HTTP).
   * Returns the parsed `result` object, or undefined on failure.
   */
  async function notionSessionCall(token, toolName, args) {
    const post = async (body, sid) => {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      };
      if (sid) headers['mcp-session-id'] = sid;
      const res = await fetch(cfg.notionMcpUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      return res;
    };
    const initRes = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-notion-plugin', version: '1.0' } } });
    if (!initRes.ok) throw new Error(`initialize ${initRes.status}`);
    const sid = initRes.headers.get('mcp-session-id') || undefined;
    await initRes.text();
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid).catch(() => {});
    const callRes = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: args || {} } }, sid);
    const text = await callRes.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    const content = payload?.result?.content?.[0]?.text;
    if (!content) return undefined;
    try { return JSON.parse(content); } catch { return content; }
  }

  /**
   * Detect whether the account's workspace has completed the official Notion
   * setup (notion-setup). This reads the workspace (not local state), so it stays
   * correct across disconnect/reconnect. Signals, per the official guide:
   *  - a page titled exactly "Agent Operating Guide", or
   *  - a memory titled exactly "Notion agent setup choice".
   */
  async function probeSetupStatus(accountId) {
    // A manual override wins: the user marked this workspace as set up.
    const setupRec = await readRecordSafe('notion/setup').catch(() => undefined);
    if (setupRec && setupRec.done && setupRec.done[accountId]) {
      return { initialized: true, evidence: { via: 'manual' } };
    }
    const token = await ensureFreshTokenFor(accountId).catch(() => undefined);
    if (!token) return { initialized: false, reason: 'no-token' };
    const exact = (items, title) => (items || []).find((it) => (it.title || '').trim().toLowerCase() === title.toLowerCase());
    try {
      let guide;
      try {
        const s = await notionSessionCall(token, 'notion-search', { query: 'Agent Operating Guide', page_size: 10 });
        guide = exact(s && s.results, 'Agent Operating Guide');
      } catch { /* search may be unavailable */ }
      let memory;
      try {
        const m = await notionSessionCall(token, 'notion-memory-search', { query: 'Notion agent setup choice', limit: 10 });
        memory = exact(m && m.results, 'Notion agent setup choice');
      } catch { /* memory may be unavailable */ }
      const found = guide || memory;
      return {
        initialized: Boolean(found),
        evidence: found ? { id: found.id, title: found.title, url: found.url, via: guide ? 'guide' : 'memory' } : undefined,
      };
    } catch (e) {
      return { initialized: false, reason: e && e.message ? e.message : 'probe-failed' };
    }
  }

  async function buildAuthorizationUrl() {    const client = await ensureClient();
    const { verifier, challenge } = pkcePair();
    const st = b64url(randomBytes(16));
    state.pending.set(st, { verifier, createdAt: nowSec() });
    if (timer?.timeout) {
      try { timer.timeout(() => state.pending.delete(st), 10 * 60 * 1000); } catch { /* ignore */ }
    }
    const u = new URL(cfg.authorizationEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', client.client_id);
    u.searchParams.set('redirect_uri', cfg.redirectUri);
    u.searchParams.set('scope', cfg.scopes);
    u.searchParams.set('state', st);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
  }

  // ---- 3. Fixed-port OAuth callback server --------------------------------
  const callback = new URL(cfg.redirectUri);
  const callbackPort = Number(callback.port) || cfg.callbackPort;
  const callbackPath = cfg.callbackPath || '/callback';

  const callbackServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', cfg.redirectUri);
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        const desc = url.searchParams.get('error_description') || '';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>Notion authorization failed</h2><p>${err}: ${desc}</p>`);
        return;
      }
      const code = url.searchParams.get('code');
      const st = url.searchParams.get('state');
      const entry = st && state.pending.get(st);
      if (!code || !entry) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Notion authorization failed</h2><p>Missing or unknown code/state.</p>');
        return;
      }
      state.pending.delete(st);
      const json = await exchangeToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: entry.verifier,
      });
      const account = normalizeTokens(json);
      // Enrich with the person's email and canonical workspace identity via
      // notion-get-self (token response only carries email_domain).
      try {
        const self = await fetchNotionSelf(account.access_token);
        if (self) {
          account.email = self.user?.email || account.email;
          account.workspace_name = self.workspace?.name || account.workspace_name;
          // workspace icon is not on get-self; keep whatever token response gave.
        }
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-notion-plugin] get-self enrichment failed: ${e?.message || e}`);
      }
      await upsertAccount(account);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Notion connected</h2><p>You can close this window and return to DeepSeek Harness.</p>');
      ctx.logger?.info?.('[dsh-notion-plugin] Notion OAuth completed; account stored.');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Notion authorization error</h2><p>${String(e?.message || e)}</p>`);
      ctx.logger?.warn?.(`[dsh-notion-plugin] OAuth callback error: ${e?.message || e}`);
    }
  });

  if (ctx.effect) {
    ctx.effect(() => {
      callbackServer.listen(callbackPort, '127.0.0.1', () => {
        ctx.logger?.info?.(`[dsh-notion-plugin] OAuth callback listening on http://localhost:${callbackPort}${callbackPath}`);
      });
      callbackServer.on('error', (e) => {
        ctx.logger?.warn?.(`[dsh-notion-plugin] OAuth callback server error: ${e.message}`);
      });
      return () => { try { callbackServer.close(); } catch { /* ignore */ } };
    });
  }

  // ---- 3b. Local management JSON API (for the settings UI) ----------------
  // A tiny CORS-enabled JSON API on its own port. The Client settings page
  // fetches this directly, avoiding a typert Remote dependency. Binds loopback
  // only; CORS allows the DSH web origin.
  const apiPort = cfg.apiPort || 53684;
  function readBody(req) {
    return new Promise((resolve) => {
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    });
  }
  // Proxy a Notion app page for embedding. The Notion app loads its JS/CSS from
  // root-relative paths (/_assets/...), so a single-HTML proxy 404s everything.
  // We expose a path-prefixed proxy: /embed/<encodedOrigin>/<rest>. HTML bodies
  // get root-relative and absolute same-origin URLs rewritten through the proxy;
  // every other asset is streamed back unchanged. The `frame-ancestors` CSP
  // directive (and X-Frame-Options) is stripped so a DSH iframe can render it.
  const EMBED_ALLOWED_HOSTS = new Set(['app.notion.com', 'www.notion.so', 'notion.so', 'app.prod.notion.com', 'app.canary.notion.com']);
  function embedBase(origin) { return `/embed/${encodeURIComponent(origin)}`; }
  async function handleEmbed(u, res) {
    // Path form: /embed/<encOrigin>/<rest...>
    let rest = u.pathname.replace(/^\/embed\//, '');
    let originStr;
    const slash = rest.indexOf('/');
    originStr = slash >= 0 ? decodeURIComponent(rest.slice(0, slash)) : decodeURIComponent(rest);
    const tail = slash >= 0 ? rest.slice(slash) : '/';
    // Back-compat: /embed?url=... (treat as the document)
    if (!originStr && u.searchParams.get('url')) originStr = u.searchParams.get('url');
    let origin;
    try { origin = new URL(originStr); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad url'); return; }
    if (origin.protocol !== 'https:' || !EMBED_ALLOWED_HOSTS.has(origin.hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('host not allowed'); return;
    }
    let targetUrl;
    if (u.searchParams.get('url') && !u.pathname.startsWith('/embed/')) {
      targetUrl = u.searchParams.get('url');
    } else {
      targetUrl = origin.origin + tail + (u.search || '');
    }
    const upstream = await fetch(targetUrl, { redirect: 'follow', headers: { 'user-agent': 'dsh-notion-embed/1.0' } });
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
      if (key === 'x-frame-options') return;
      if (key === 'content-security-policy') {
        const parts = v.split(';').map((s) => s.trim()).filter((s) => s && !/^frame-ancestors\b/i.test(s));
        outHeaders[k] = parts.join('; ');
        return;
      }
      outHeaders[k] = v;
    });
    const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/html')) {
      // Rewrite URLs so sub-resources load back through this proxy.
      let html = await upstream.text();
      const base = embedBase(origin.origin);
      // Absolute same-origin URLs -> proxy path
      html = html.split(origin.origin).join(base);
      // Root-relative attribute URLs -> proxy path (only when preceded by = or quote)
      html = html.replace(/((?:src|href|poster|action)=["'])\/(?!\/)/g, `$1${base}/`);
      // Root-relative URL() in CSS
      html = html.replace(/url\((['"]?)\/(?!\/)/g, `url($1${base}/`);
      outHeaders['content-type'] = 'text/html; charset=utf-8';
      const buf = Buffer.from(html, 'utf8');
      outHeaders['content-length'] = String(buf.length);
      res.writeHead(upstream.status, outHeaders);
      res.end(buf);
      return;
    }
    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  }

  const apiServer = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const send = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const u = new URL(req.url || '/', `http://localhost:${apiPort}`);
      const p = u.pathname;
      if (p === '/api/accounts' && req.method === 'GET') {
        return send(200, await notionService.listAccounts());
      }
      if (p === '/api/skills' && req.method === 'GET') {
        return send(200, await notionService.listSkills());
      }
      if (p === '/api/auth-url' && req.method === 'GET') {
        return send(200, await notionService.beginAuthorization());
      }
      if (p === '/api/setup-status' && req.method === 'GET') {
        return send(200, await notionService.setupStatus(u.searchParams.get('id') || undefined));
      }
      if (p === '/api/last-open' && req.method === 'GET') {
        // Return the most recent notion_open_page request (consumed by the Client
        // watcher to auto-open in the browser). `ack` clears it once opened.
        const q = u.searchParams.get('ack');
        const cur = getOpenPage();
        if (q && cur && String(cur.at) === q) setOpenPage(undefined);
        const now = getOpenPage();
        return send(200, now ? { url: now.url, at: now.at } : {});
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (p === '/api/active') return send(200, await notionService.setActive(body.id));
        if (p === '/api/remove') return send(200, await notionService.removeAccount(body.id));
        if (p === '/api/skill') return send(200, await notionService.setSkillEnabled(body.name, body.enabled));
        if (p === '/api/setup-done') return send(200, await notionService.markSetupDone(body && body.id));
      }
      // /embed?url=<encoded notion app url> — proxy the Notion MCP page and strip
      // the frame-ancestors CSP directive so it can render inside a DSH iframe.
      if ((p === '/embed' || p.startsWith('/embed/')) && req.method === 'GET') {
        return await handleEmbed(u, res);
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  });
  if (ctx.effect) {
    ctx.effect(() => {
      apiServer.listen(apiPort, '127.0.0.1', () => {
        ctx.logger?.info?.(`[dsh-notion-plugin] Management API on http://localhost:${apiPort}/api`);
      });
      apiServer.on('error', (e) => ctx.logger?.warn?.(`[dsh-notion-plugin] api server error: ${e.message}`));
      return () => { try { apiServer.close(); } catch { /* ignore */ } };
    });
  }

  // ---- 4. Authorization flow registration ---------------------------------
  // Lets surfaces list "Notion" as authorizable and run the browser flow.
  if (ctx.authorization) {
    try {
      ctx.authorization.registerFlow({
        key: accountsKey,
        label: 'Notion (MCP OAuth)',
        methods: [{ id: 'browser', label: 'Open browser and sign in to Notion' }],
        async run(session) {
          const before = await readAccounts();
          const knownIds = new Set(before.accounts.map((a) => a.id));
          const url = await buildAuthorizationUrl();
          session.notify({ message: 'Open this URL to authorize Notion:', url });
          // Wait until a NEW account appears (the callback upserts it) or abort.
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            if (session.signal?.aborted) throw new Error('authorization cancelled');
            const store = await readAccounts();
            const added = store.accounts.find((a) => a.id && a.access_token && !knownIds.has(a.id));
            if (added) {
              await session.commit({ kind: 'grant', payload: { v: 1, activeId: added.id, accounts: store.accounts } });
              return;
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
          throw new Error('authorization timed out waiting for the browser callback');
        },
      });
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-notion-plugin] Failed to register authorization flow: ${e.message}`);
    }
  }

  // ---- 5. Local authenticated MCP proxy -----------------------------------


  // Native handler so POST (JSON-RPC) and long-lived SSE responses both work;
  // a WebResourceRoute would answer non-GET/HEAD with 405.
  async function proxyRouteHandler(req, res) {
    try {
      // Optional per-request workspace selection: x-notion-account carries an
      // account id (workspace_id) or exact workspace name; absent -> active.
      const wantAccount = (req.headers['x-notion-account'] || '').toString().trim();
      let grant;
      if (wantAccount) {
        const store = await readAccounts();
        const match = store.accounts.find((a) => a.id === wantAccount || a.workspace_id === wantAccount || a.workspace_name === wantAccount);
        grant = await ensureFreshTokenFor(match && match.id).catch(() => undefined);
      } else {
        grant = await ensureFreshToken().catch(() => undefined);
      }
      if (!grant || !grant.access_token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_authorized', message: 'Notion is not connected. Connect a workspace in Settings → Notion.' }));
        return;
      }
      const incoming = new URL(req.url || '/', 'http://localhost');
      // The MCP client talks to this dedicated server; forward everything to
      // Notion's single /mcp endpoint regardless of the incoming path.
      const target = new URL(cfg.notionMcpUrl);
      target.search = incoming.search;

      const fwdHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'authorization' || k === 'content-length' || k === 'x-notion-account') continue;
        if (v !== undefined) fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      fwdHeaders.authorization = `Bearer ${grant.access_token}`;

      const isBody = !['GET', 'HEAD'].includes(req.method || 'GET');
      const upstreamRes = await fetch(target.toString(), {
        method: req.method,
        headers: fwdHeaders,
        body: isBody ? req : undefined,
        duplex: 'half',
        redirect: 'manual',
      });

      const outHeaders = {};
      upstreamRes.headers.forEach((v, k) => {
        if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') return;
        outHeaders[k] = v;
      });
      res.writeHead(upstreamRes.status, outHeaders);
      if (!upstreamRes.body) { res.end(); return; }
      const reader = upstreamRes.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(Buffer.from(value));
        }
      };
      pump().catch((e) => {
        try { res.destroy(e); } catch { /* ignore */ }
      });
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-notion-plugin] proxy error: ${e?.message || e}`);
      try {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_error', message: String(e?.message || e) }));
      } catch { /* ignore */ }
    }
  }

  // The proxy runs on its own fixed loopback port so the MCP client can be
  // configured with a static URL (no Loader-scoped !!js evaluation needed).
  const proxyPort = cfg.proxyPort || 53683;
  const proxyServer = createServer((req, res) => { proxyRouteHandler(req, res); });

  if (ctx.effect) {
    ctx.effect(() => {
      proxyServer.listen(proxyPort, '127.0.0.1', () => {
        ctx.logger?.info?.(`[dsh-notion-plugin] Notion MCP proxy listening on http://localhost:${proxyPort}/mcp`);
      });
      proxyServer.on('error', (e) => {
        ctx.logger?.error?.(`[dsh-notion-plugin] MCP proxy server error: ${e.message}`);
      });
      return () => { try { proxyServer.close(); } catch { /* ignore */ } };
    });
  }

  // ---- 6. Commands --------------------------------------------------------
  // No Notion slash commands: a command cannot hand control to the agent (DSH
  // executes commands log-only, without sending them to the model). The agent
  // entry point is the `notion` skill registered below.

  // ---- 7. Skills initialization (after credential helpers exist) -----------
  try {
    skillDefs.push(...collectSkillDefs());
    const saved = await readRecordSafe('notion/skills');
    if (saved && Array.isArray(saved.disabled)) for (const n of saved.disabled) disabledSkills.add(n);
    applySkillRegistrations();
  } catch (e) {
    ctx.logger?.warn?.(`[dsh-notion-plugin] Failed initializing skills: ${e.message}`);
  }

  // ---- 8. Host service for the settings UI (typert Remote) -----------------
  const notionService = {
    async listAccounts() {
      const store = await readAccounts();
      return {
        activeId: store.activeId,
        accounts: store.accounts.map((a) => ({
          id: a.id,
          email: a.email || a.email_domain || '',
          workspaceName: a.workspace_name || '',
          workspaceIcon: a.workspace_icon || '',
          workspaceId: a.workspace_id || '',
        })),
      };
    },
    async setActive(id) {
      await setActiveAccount(id);
      return this.listAccounts();
    },
    async removeAccount(id) {
      await removeAccount(id);
      return this.listAccounts();
    },
    async beginAuthorization() {
      return { url: await buildAuthorizationUrl() };
    },
    async listSkills() {
      return {
        skills: skillDefs.map((d) => ({
          name: d.name,
          title: skillDisplayTitle(d.name),
          description: skillDisplayShort(d.name, d.description),
          enabled: !disabledSkills.has(d.name),
        })),
      };
    },
    async setSkillEnabled(name, enabled) {
      await setSkillEnabled(name, Boolean(enabled));
      return this.listSkills();
    },
    async setupStatus(accountId) {
      const store = await readAccounts();
      const id = accountId || store.activeId;
      if (!id) return { initialized: false, reason: 'no-account' };
      return probeSetupStatus(id);
    },
    async markSetupDone(accountId) {
      const store = await readAccounts();
      const id = accountId || store.activeId;
      if (!id) return { ok: false, reason: 'no-account' };
      const rec = (await readRecordSafe('notion/setup').catch(() => undefined)) || { v: 1, done: {} };
      const done = Object.assign({}, rec.done || {}, { [id]: nowSec() });
      await writeRecordSafe('notion/setup', { v: 1, done });
      return { ok: true, id, setupStatus: { initialized: true } };
    },
  };
  // `notionService` backs both the management API and the agent tools below.
  void notionService;

  // ---- 9. Agent tools: list workspaces / choose active workspace -----------
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const textOutput = { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] };
    try {
      ctx.tools.register({
        name: 'notion_list_workspaces',
        description: 'List the Notion workspaces (accounts) connected to DeepSeek Harness, with which one is active. Call this before using Notion when more than one workspace may be connected, so you can ask the user which workspace to use.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput,
        async execute() {
          const store = await readAccounts();
          return JSON.stringify({
            activeId: store.activeId,
            workspaces: store.accounts.map((a) => ({
              id: a.id,
              workspaceId: a.workspace_id,
              name: a.workspace_name,
              email: a.email || a.email_domain,
              active: a.id === store.activeId,
            })),
          }, null, 2);
        },
      });
      ctx.tools.register({
        name: 'notion_use_workspace',
        description: 'Select which connected Notion workspace subsequent Notion tools operate on. Pass a workspace id or name from notion_list_workspaces.',
        parameters: {
          type: 'object',
          properties: { workspace: { type: 'string', description: 'Workspace id or exact workspace name' } },
          required: ['workspace'],
          additionalProperties: false,
        },
        output: textOutput,
        async execute(args) {
          const store = await readAccounts();
          const want = String(args && args.workspace || '').trim();
          const match = store.accounts.find((a) => a.id === want || a.workspace_id === want || a.workspace_name === want);
          if (!match) return JSON.stringify({ ok: false, error: `No connected workspace matches "${want}"`, available: store.accounts.map((a) => ({ id: a.id, name: a.workspace_name })) });
          await setActiveAccount(match.id);
          return JSON.stringify({ ok: true, activeId: match.id, name: match.workspace_name });
        },
      });
      ctx.tools.register({
        name: 'notion_open_page',
        description: 'Show a Notion page (or workspace) to the user after creating or updating it. Pass the page URL returned by Notion tools, or a page id. On the desktop app it opens in the right-side browser panel; otherwise the result includes a clickable link the user can open in a new tab.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'A Notion page URL (https://www.notion.so/... or app.notion.com/...)' },
            page_id: { type: 'string', description: 'A Notion page id (if url is not given)' },
          },
          additionalProperties: false,
        },
        output: textOutput,
        async execute(args) {
          const src = String((args && (args.url || args.page_id)) || '').trim();
          if (!src) return JSON.stringify({ ok: false, error: 'Provide a url or page_id' });
          let url;
          const uuid = src.replace(/-/g, '').match(/[0-9a-f]{32}/i);
          if (/^https?:\/\//i.test(src)) {
            try {
              const u = new URL(src);
              if (!/(^|\.)notion\.(so|com|site)$/i.test(u.hostname)) return JSON.stringify({ ok: false, error: 'Not a Notion URL' });
              url = u.toString();
            } catch { return JSON.stringify({ ok: false, error: 'Invalid URL' }); }
          } else if (uuid) {
            const id = uuid[0];
            const dashed = `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
            url = `https://www.notion.so/${dashed}`;
          } else {
            return JSON.stringify({ ok: false, error: 'Could not parse a Notion page id or URL' });
          }
          // Remember the last page so a Client view can offer a "reopen" affordance.
          setOpenPage({ url, at: nowSec() });
          setLastUrl({ url, pageId: parseNotionId(url), at: nowSec() });
          return JSON.stringify({ ok: true, url, markdown: `[Open in Notion](${url})` });
        },
      });
      ctx.tools.register({
        name: 'notion_current_page',
        description: 'Return the Notion page currently open in the user\'s sidebar browser — its URL and page id — so you can answer questions about "this page" by reading it with the Notion tools. Only reflects pages opened through Notion tools; if the user navigated elsewhere manually, ask them to paste the link or call notion_open_page.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput,
        async execute() {
          const cur = getLastUrl();
          if (!cur || !cur.url) {
            return JSON.stringify({ ok: false, error: 'No page has been opened through Notion tools yet. Ask the user for the page URL, or call notion_open_page first.' });
          }
          return JSON.stringify({
            ok: true,
            url: cur.url,
            pageId: cur.pageId || parseNotionId(cur.url),
            openedAt: cur.at,
            hint: 'Use notion page tools (search/fetch with this page id) to read its content.',
          });
        },
      });
      ctx.tools.register({
        name: 'notion_setup_status',
        description: 'Check whether a Notion workspace has completed the official Notion setup (the notion-setup skill: an "Agent Operating Guide" page and setup-choice memory). Reads the workspace itself, so the result is correct across disconnect/reconnect. Pass a workspace id (defaults to the active one).',
        parameters: {
          type: 'object',
          properties: { workspace: { type: 'string', description: 'Workspace id (optional; defaults to the active workspace)' } },
          additionalProperties: false,
        },
        output: textOutput,
        async execute(args) {
          const store = await readAccounts();
          const want = String((args && args.workspace) || '').trim();
          const acct = want
            ? store.accounts.find((a) => a.id === want || a.workspace_id === want || a.workspace_name === want)
            : store.accounts.find((a) => a.id === store.activeId);
          if (!acct) return JSON.stringify({ ok: false, error: want ? `No connected workspace matches "${want}"` : 'No connected workspace' });
          const st = await probeSetupStatus(acct.id);
          return JSON.stringify({ ok: true, workspace: acct.workspace_name, initialized: st.initialized, evidence: st.evidence, reason: st.reason });
        },
      });
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-notion-plugin] Failed registering tools: ${e.message}`);
    }
  }
}
