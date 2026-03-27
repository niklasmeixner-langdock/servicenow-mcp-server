# ServiceNow MCP Server

An MCP server that connects to ServiceNow, demonstrating OAuth Dynamic Client Registration (DCR) and interactive UI forms.

## Features

- **OAuth DCR**: Implements MCP's OAuth Dynamic Client Registration spec - clients register automatically
- **Interactive Forms**: Renders dynamic forms for creating ServiceNow records
- **Form Pre-filling**: LLM can extract context from conversation to pre-populate fields

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   MCP Client    │────▶│   MCP Server    │────▶│   ServiceNow    │
│   (Langdock)    │     │  (this server)  │     │      API        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**OAuth Flow:**
1. Client discovers OAuth endpoints via `/.well-known/oauth-authorization-server`
2. Client registers via `/register` (DCR)
3. Client initiates OAuth via `/authorize` → redirects to ServiceNow
4. User authenticates with ServiceNow
5. Callback to `/oauth/callback` → redirects to client with code
6. Client exchanges code for token via `/token`
7. Client uses token for `/mcp` requests

## Quick Start

### 1. ServiceNow OAuth Setup

1. In ServiceNow, go to **System OAuth > Application Registry**
2. Create a new **OAuth API endpoint for external clients**
3. Set the redirect URL to `{YOUR_SERVER_URL}/oauth/callback`
4. Note the Client ID and Secret

### 2. Environment Variables

```bash
export SERVICENOW_INSTANCE=dev12345              # Your instance subdomain
export SERVICENOW_CLIENT_ID=your-client-id       # From step 1
export SERVICENOW_CLIENT_SECRET=your-secret      # Optional, for confidential clients
export BASE_URL=https://your-server.railway.app  # Your server's public URL
export PORT=3000                                 # Optional, defaults to 3000
```

### 3. Run

```bash
pnpm install
pnpm build
pnpm start
```

## Project Structure

```
src/
├── index.ts           # Express server, MCP tools, OAuth endpoints
├── oauth-provider.ts  # OAuth DCR provider implementation
├── client.ts          # ServiceNow API client
├── utils.ts           # Configuration helpers
└── ui/
    └── form.html      # Interactive form UI
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_form_fields` | Get available fields for a ServiceNow table |
| `submit_form` | Submit a record to a ServiceNow table |
| `render_form` | Display an interactive form with optional pre-fill |

### Example: render_form with pre-fill

```json
{
  "table": "incident",
  "prefill": {
    "short_description": "Laptop won't turn on",
    "urgency": "2"
  }
}
```

## Adapting for Other Services

This server can be adapted for any OAuth-protected API:

1. **Update `oauth-provider.ts`**: Change token endpoints and scopes for your service
2. **Update `client.ts`**: Implement your service's API calls
3. **Update tools in `index.ts`**: Define tools relevant to your service

### Key Implementation Notes

- The `/authorize` endpoint is handled directly (before `mcpAuthRouter`) to avoid the SDK's redirect_uri validation which requires persistent client storage
- In-memory storage is used for simplicity - use Redis/PostgreSQL in production
- ServiceNow requires PKCE (`code_challenge`) for OAuth

## Deployment

Deploy to any Node.js platform (Railway, Fly.io, Render, etc.):

```bash
pnpm build
node dist/index.js
```

Ensure `BASE_URL` matches your deployment URL for OAuth callbacks.

## License

ISC
