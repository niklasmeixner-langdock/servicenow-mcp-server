# ServiceNow MCP Server

MCP server for ServiceNow - submit forms to any ServiceNow table via the Model Context Protocol.

## Setup

### 1. Configure ServiceNow OAuth App

Add `http://localhost:8765/callback` as a redirect URI to your ServiceNow OAuth application.

The server uses Langdock's OAuth client ID: `8f28e9ff-0dfa-42a2-8cc5-33e8b76de0c0`

### 2. Build

```bash
pnpm install
pnpm build
```

### 3. Run the Server

```bash
SERVICENOW_INSTANCE=your-instance pnpm start
```

Replace `your-instance` with your ServiceNow subdomain (e.g., `dev12345` or `dev12345.service-now.com`).

The server runs on port 3000 by default. Set `PORT` env var to change it.

### 4. First Run / Authentication

On first run, the server will open your browser for ServiceNow authentication. After logging in and authorizing, tokens are stored in `~/.servicenow-mcp-tokens.json`.

### 5. Connect MCP Clients

The MCP endpoint is available at:
```
http://localhost:3000/mcp
```

For remote deployment, replace `localhost:3000` with your server's URL.

### 6. Deploy (Optional)

For production deployment:

```bash
# Build
pnpm build

# Run with environment variables
PORT=3000 SERVICENOW_INSTANCE=your-instance node dist/index.js
```

Or use Docker, Railway, Fly.io, etc. with these env vars:
- `PORT` - Server port (default: 3000)
- `SERVICENOW_INSTANCE` - Your ServiceNow instance subdomain

## Tools

### get_form_fields

Fetch the form schema for a ServiceNow table. Returns field definitions that MCP clients can render as interactive UI.

**Parameters:**
- `table` - ServiceNow table name

**Returns:**
```json
{
  "table": "incident",
  "fields": [
    {
      "name": "short_description",
      "label": "Short description",
      "type": "string",
      "inputType": "text",
      "required": true,
      "maxLength": 160
    },
    {
      "name": "urgency",
      "label": "Urgency",
      "type": "choice",
      "inputType": "select",
      "required": false,
      "choices": [
        { "value": "1", "label": "1 - High" },
        { "value": "2", "label": "2 - Medium" },
        { "value": "3", "label": "3 - Low" }
      ]
    }
  ]
}
```

**Input types returned:**
- `text` - Single line text input
- `textarea` - Multi-line text (journals, HTML)
- `select` - Dropdown with choices
- `number` - Numeric input
- `boolean` - Checkbox
- `date` - Date picker
- `datetime` - Date/time picker
- `reference` - Reference to another table (sys_id)

### submit_form

Submit a record to any ServiceNow table.

**Parameters:**
- `table` - ServiceNow table name (e.g., `incident`, `sc_request`, `task`)
- `data` - Key-value pairs matching ServiceNow field names

**Example workflow:**
1. Call `get_form_fields` for the table to see available fields
2. Render form UI based on field definitions
3. Call `submit_form` with user-provided data

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVICENOW_INSTANCE` | Yes | ServiceNow subdomain or full hostname |
