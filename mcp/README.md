# MSRE MCP server

This local server lets an MCP client work with the Markdown-backed MSRE collection while Obsidian remains the only writer. Requests are signed, placed in the vault-local queue, validated by the plugin, and recorded in an audit log.

## Setup

1. In **MSRE → Settings → Data → Automation & MCP**, enable the API, changes, and MCP queue.
2. Copy the access token.
3. Add this server to your MCP client:

```json
{
    "mcpServers": {
        "msre": {
            "command": "node",
            "args": ["/absolute/path/to/msre-mcp-server.mjs"],
            "env": {
                "MSRE_VAULT_PATH": "/absolute/path/to/your/vault",
                "MSRE_TOKEN": "paste-the-token-here"
            }
        }
    }
}
```

The server provides `create_card`, `create_deck`, `add_media`, `find_cards`, `update_note`, `get_statistics`, `check_integrity`, and `import_cards`. Obsidian must be open to process requests. Configure allowed deck roots in settings to restrict writes.

## AI co-author with Codex or another MCP client

The repository root is also a valid Codex plugin (`.codex-plugin/plugin.json` + `.mcp.json`). When installing it locally, expose `MSRE_VAULT_PATH` and `MSRE_TOKEN` to the plugin process; the bundled configuration starts this same MCP server.

The **MCP / Codex** route in the card editor never sends a request to a fixed model. It places a transparent request in `Automation/AI/Requests`. A connected agent can:

1. call `list_ai_requests`;
2. create grounded card drafts or a field-level editing proposal from the request's source and task;
3. call `resolve_ai_request` with `{ requestId, result: { summary, cards, replacement, acceptedAnswers, hint, explanation } }`, or `reject_ai_request`. Unused result fields may be omitted for MCP responses.

The proposal returns to the open card editor, where the user reviews it before applying. Field-level requests contain only the selected text or the active field, never the whole vault. The agent cannot silently save a change. This works with Codex when this MCP server is installed as a Codex plugin/server, and with any compatible local MCP client.

Another Obsidian plugin can provide Codex or a different model directly without using the queue by calling `plugin.api.registerAiProvider(...)`; see `api.d.ts` for the contract. This is the portable option for mobile integrations that already have their own authenticated model connection.
