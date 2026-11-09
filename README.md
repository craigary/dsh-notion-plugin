# Notion workspace plugin for DeepSeek Harness

A DSH (DeepSeek Harness) port of Notion's official
[`claude-code-notion-plugin`](https://github.com/makenotion/claude-code-notion-plugin).
It bundles the same three pieces as a single installable Cordis bundle:

1. **Notion MCP server** — connects to Notion's hosted MCP endpoint
   (`https://mcp.notion.com/mcp`) through the shipped `@deepseek-ai/dsh-mcp-client`
   plugin, exposing tools like `mcp__notion__search`, `mcp__notion__create-page`,
   `mcp__notion__query-database`, and so on.
2. **12 Notion skills** from the Notion Cookbook — registered as runtime skills so
   both the model and the user can invoke them (`notion-database-designer`,
   `notion-meeting-intelligence`, `notion-research-documentation`, …). Each skill
   also registers an alias without the `notion-` prefix.
3. **Slash commands** — `/notion-search`, `/notion-create-page`,
   `/notion-database-query`, `/notion-create-task`,
   `/notion-create-database-row`, `/notion-find`, `/notion-tasks-setup`,
   `/notion-tasks-build`, `/notion-tasks-plan`, `/notion-explain-diff`,
   `/notion-setup`.

## Differences from the Claude Code plugin

Claude Code plugins ship Markdown commands and an `.mcp.json`. DSH composes a
profile from Cordis patch layers instead, so this bundle:

- declares the MCP server as an `@deepseek-ai/dsh-mcp-client` row in
  `cordis.patch.yml`, and
- registers skills and commands programmatically from `index.js` via the DSH
  `skills` and `commands` host services.

The `commands/*.md` files are retained as human-readable reference prompts; the
live commands are the definitions in `index.js`.

## Authentication (MCP OAuth 2.0 with dynamic client registration)

Notion's hosted MCP server requires **OAuth 2.0** and, per Notion's
[Build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client)
guide, MCP clients register via **Dynamic Client Registration (RFC 7591)**. The
DSH MCP client only supports static headers, so this plugin runs the whole flow
itself and exposes a local authenticated proxy:

1. On first authorization the plugin POSTs `https://mcp.notion.com/register`
   (public client, `token_endpoint_auth_method: none`, PKCE) and stores the
   returned `client_id`/`client_secret` as a credential record
   (`notion-mcp-oauth-client`) so later authorizations reuse it — re-registering
   would orphan prior grants.
2. It opens the Notion consent screen (authorization-code + PKCE, `S256`); after
   you approve, Notion redirects to the fixed local callback
   `http://localhost:53682/callback`, which exchanges the code for tokens and
   stores them (`notion-mcp-oauth`).
3. The MCP client is configured to talk to `/notion-mcp-oauth` on the DSH
   origin. On every request the proxy injects a fresh
   `Authorization: Bearer <access_token>`, refreshing proactively before expiry
   and persisting rotated refresh tokens. On `invalid_grant` it clears the grant
   and requires re-authorization.

Run `/notion-setup` to start (or restart) the flow.

> Note: ordinary Notion OAuth "login" connections (created in the Notion UI with
> a redirect URI) are **not** valid MCP clients — the MCP server only accepts
> dynamically registered clients, which is why such a `client_id` returns
> `Invalid client_id` from `/authorize`.

### Why the client shows a generic logo in Notion

Notion displays a real client logo only for clients it has whitelisted (for
example ChatGPT). Dynamically registered clients appear with the generic
mark; the public build-client documentation does not expose a self-service
logo-whitelist process.

## Install

From a DSH session, install the bundle directory with `plugin_manager`
`install_bundle` (target: the absolute path of this directory). The bundle is
local and private; it is not published to a registry.

## Layout

```
package.json          bundle manifest (dsh.bundle.patch)
cordis.patch.yml      inserts the MCP client row + this plugin row
index.js              registers skills + commands
skills/               12 Notion Cookbook skills (each with SKILL.md)
commands/             reference Markdown prompts
locale/en.json        Plugin Manager title/description (English)
locale/zh.json        Plugin Manager title/description (Chinese)
icon.svg              plugin icon
```

## Credits

Skills and MCP server by Notion. Original Claude Code plugin specification by
Anthropic. Ported to DSH as a Cordis bundle.
