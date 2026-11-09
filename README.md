# dsh-notion-plugin

Use Notion from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH): a hosted MCP connection, 12 Notion Cookbook skills, and a settings page
for multiple workspaces.

A DSH port of Notion's official
[`claude-code-notion-plugin`](https://github.com/makenotion/claude-code-notion-plugin).

## What you get

- **Notion MCP tools** — search, read, create, and edit pages and databases via
  Notion's hosted MCP server (`https://mcp.notion.com/mcp`).
- **12 skills** — e.g. `notion-database-designer`, `notion-meeting-intelligence`,
  `notion-research-documentation`, `notion-knowledge-capture`.
- **Multi-workspace** — connect several workspaces; one is active at a time.
  The agent can list and switch with `notion_list_workspaces` / `notion_use_workspace`.
- **`notion_open_page`** — open a result in the desktop right-sidebar browser
  (or a new tab elsewhere).

There are no slash commands: DSH runs commands locally without sending them to
the model, so the skills plus natural language replace them.

## Install

Install this directory as a DSH bundle (`plugin_manager` → `install_bundle`,
target = this folder). It is not published to a registry.

## Connect a workspace

Open the plugin's **Settings** page and press **Connect**. The plugin runs
Notion's OAuth (dynamic client registration + PKCE) on a local callback
(`http://localhost:53682/callback`) and forwards MCP traffic through a local
proxy (`http://localhost:53683/mcp`) that injects and refreshes the token for
the active account. Use **Open Notion** to sign in once in the sidebar browser.

> A Notion "login" connection created in the Notion UI is not a valid MCP
> client — only dynamically registered clients are accepted.

## Layout

```
package.json        bundle manifest (dsh.bundle.patch)
cordis.patch.yml    MCP client row + this plugin row
index.js            skills, OAuth, local MCP proxy, tools
client.js           settings page + sidebar-open watcher
skills/             12 skills (each with SKILL.md)
locale/             plugin title/description (en, zh)
icon.svg            plugin icon
```

## Known limitation

The desktop sidebar browser uses a non-persistent session, so you sign in to
Notion again after each app restart. Persistent login would need the host to
use a `persist:` session partition.

## Credits

Skills and MCP server by Notion. Ported to DSH as a Cordis bundle.
