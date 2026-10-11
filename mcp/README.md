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
