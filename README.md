# ServiceNow MCP Server

A reference implementation of an MCP server with interactive UI forms. Use this as a template for building MCP servers that need to collect user input via forms.

## Features

- **Interactive Forms**: Renders dynamic forms in MCP-compatible hosts
- **Form Pre-filling**: LLM can extract context from conversation to pre-populate fields
- **OAuth Authentication**: PKCE flow for secure ServiceNow authentication
- **Multiple Host Support**: Works with MCP Apps hosts and legacy UIResourceRenderer

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   MCP Client    │────▶│   MCP Server    │────▶│   ServiceNow    │
│  (Claude, etc)  │     │  (this server)  │     │      API        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │                       │ Returns form schema
        │                       │ + UI resource
        ▼                       ▼
┌─────────────────────────────────────────┐
│              MCP Host UI                │
│  ┌───────────────────────────────────┐  │
│  │         form.html (iframe)        │  │
│  │  - Receives schema via postMessage│  │
│  │  - Renders dynamic form           │  │
│  │  - Submits via tools/call         │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server setup, tool registration |
| `src/auth.ts` | OAuth PKCE authentication flow |
| `src/client.ts` | ServiceNow API client |
| `src/ui/form.html` | Interactive form UI (rendered in iframe) |

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment

```bash
export SERVICENOW_INSTANCE=your-instance  # e.g., dev12345
export BASE_URL=http://localhost:3000     # Your server's public URL
export PORT=3000                          # Optional, defaults to 3000
```

### 3. Build & Run

```bash
pnpm build
pnpm start
```

### 4. Authenticate

Visit `http://localhost:3000/auth` to start the OAuth flow with ServiceNow.

## Tools

### get_form_fields

Fetch form schema and display an interactive form.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `table` | string | Yes | ServiceNow table name (e.g., `incident`, `sc_request`) |
| `prefill` | object | No | Key-value pairs to pre-populate form fields |

**Example with prefill:**
```json
{
  "table": "incident",
  "prefill": {
    "short_description": "Laptop won't turn on",
    "description": "User reports laptop not booting since this morning. Tried power cycling.",
    "urgency": "2"
  }
}
```

The LLM can extract relevant information from the conversation and pass it via `prefill` to pre-populate the form for the user.

### submit_form

Submit a record to any ServiceNow table.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `table` | string | Yes | ServiceNow table name |
| `data` | object | Yes | Field values to submit |

## MCP Apps Integration

This server implements the MCP Apps pattern for interactive UIs:

### 1. Register UI Resource

```typescript
registerAppResource(
  server,
  "ui://servicenow/form",  // Resource URI
  "ui://servicenow/form",  // Resource name
  { mimeType: RESOURCE_MIME_TYPE },
  async () => ({ contents: [{ uri, mimeType, text: html }] })
);
```

### 2. Link Tool to UI

```typescript
registerAppTool(
  server,
  "get_form_fields",
  {
    // ... tool config
    _meta: { ui: { resourceUri: "ui://servicenow/form" } }
  },
  async ({ table, prefill }) => {
    // Return data for the UI
    return {
      content: [{ type: "text", text: JSON.stringify(schema) }],
      _meta: {
        "mcpui.dev/ui-initial-render-data": { ...schema, prefill }
      }
    };
  }
);
```

### 3. Form Communication

The form (`form.html`) communicates with the host via `postMessage`:

**Receiving data:**
```javascript
window.addEventListener("message", (event) => {
  // MCP Apps hosts send: { method: "ui/notifications/tool-result", params: { _meta: {...} } }
  if (event.data.method === "ui/notifications/tool-result") {
    const renderData = event.data.params._meta["mcpui.dev/ui-initial-render-data"];
    renderForm(renderData);
  }
});
```

**Calling tools:**
```javascript
window.parent.postMessage({
  jsonrpc: "2.0",
  method: "tools/call",
  id: messageId,
  params: { name: "submit_form", arguments: { table, data } }
}, "*");
```

## Adapting This Template

To use this as a template for another service:

1. **Replace ServiceNow client** (`src/client.ts`) with your service's API
2. **Update OAuth config** (`src/auth.ts`) for your service's OAuth endpoints
3. **Modify form schema** to match your service's data model
4. **Update form UI** (`src/ui/form.html`) if you need different field types

### Customization Points

```typescript
// src/auth.ts - OAuth configuration
const CLIENT_ID = "your-client-id";
const SCOPE = "your-scopes";

// src/client.ts - API endpoints
const url = `${instanceUrl}/api/your/endpoint`;

// src/index.ts - Tool definitions
server.registerTool("your_tool", { ... });
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVICENOW_INSTANCE` | Yes | ServiceNow subdomain or full hostname |
| `BASE_URL` | Yes | Public URL of this server (for OAuth callback) |
| `PORT` | No | Server port (default: 3000) |

## Development

```bash
pnpm dev  # Build and run in one command
```

## Deployment

Deploy to any Node.js hosting platform (Railway, Fly.io, etc.):

```bash
pnpm build
PORT=3000 SERVICENOW_INSTANCE=your-instance BASE_URL=https://your-app.example.com node dist/index.js
```

## License

ISC
