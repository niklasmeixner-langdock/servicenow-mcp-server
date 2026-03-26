#!/usr/bin/env node

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import {
  getAuthToken,
  ensureAuthenticated,
  getAuthUrl,
  handleCallback,
  isAuthenticated,
} from "./auth.js";
import { submitForm, getFormFields } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Use official MCP Express app (handles body parsing correctly)
const app = createMcpExpressApp({ host: "0.0.0.0" });
app.use(cors());

// MCP endpoint (handles all methods per official pattern)
app.all("/mcp", async (req: Request, res: Response) => {
  try {
    // Create MCP server instance (auth check happens per-tool, not at connection level)
    const server = createServer();

    // Create transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);

    // Handle the request (body already parsed by createMcpExpressApp)
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", authenticated: isAuthenticated() });
});

// OAuth: Start authentication
app.get("/auth", (req, res) => {
  try {
    const authUrl = getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to start auth",
    });
  }
});

// OAuth: Callback from ServiceNow
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`<h1>Authorization Failed</h1><p>${error}</p>`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("<h1>Missing code or state parameter</h1>");
    return;
  }

  try {
    await handleCallback(code as string, state as string);
    res.send(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>Successfully authenticated with ServiceNow</h1>
          <p>You can now use the MCP server.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`<h1>Authentication Error</h1><p>${err}</p>`);
  }
});

function createServer(): McpServer {
  const server = new McpServer({
    name: "servicenow-mcp-server",
    version: "1.0.0",
  });

  const formResourceUri = "ui://servicenow/form";

  // Register the UI resource for forms (name = URI per official pattern)
  registerAppResource(
    server,
    formResourceUri,
    formResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const htmlPath = path.join(__dirname, "ui", "form.html");
      const html = await fs.readFile(htmlPath, "utf-8");
      return {
        contents: [
          { uri: formResourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
        ],
      };
    },
  );

  // Register the submit_form tool (no UI needed)
  server.registerTool(
    "submit_form",
    {
      title: "Submit Form",
      description:
        "Submit a form/record to a ServiceNow table and get the response. Use this to create records in any ServiceNow table (incidents, requests, tasks, etc.)",
      inputSchema: {
        table: z
          .string()
          .describe(
            "The ServiceNow table name (e.g., 'incident', 'sc_request', 'task', 'change_request')",
          ),
        data: z
          .record(z.string(), z.unknown())
          .describe(
            "The form data to submit as key-value pairs. Field names should match ServiceNow field names (e.g., 'short_description', 'description', 'urgency')",
          ),
      },
    },
    async ({ table, data }) => {
      try {
        const token = await getAuthToken();
        if (!token) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Not authenticated. Please run the OAuth flow first.",
              },
            ],
            isError: true,
          };
        }

        const result = await submitForm(
          table,
          data as Record<string, unknown>,
          token,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error submitting form: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Register the get_form_fields tool WITH MCP UI link
  registerAppTool(
    server,
    "get_form_fields",
    {
      title: "Get Form Fields",
      description:
        "Fetch the form schema for a ServiceNow table and display an interactive form. Use the prefill parameter to pre-populate form fields with data extracted from the conversation context.",
      inputSchema: {
        table: z
          .string()
          .describe(
            "The ServiceNow table name (e.g., 'incident', 'sc_request', 'task', 'change_request')",
          ),
        prefill: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional key-value pairs to pre-fill form fields. Keys should match ServiceNow field names (e.g., 'short_description', 'description', 'urgency'). Extract relevant information from the user's message to populate these fields.",
          ),
      },
      _meta: { ui: { resourceUri: formResourceUri } },
    },
    async ({ table, prefill }) => {
      try {
        const token = await getAuthToken();
        if (!token) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Not authenticated" }),
              },
            ],
            isError: true,
          };
        }

        const schema = await getFormFields(table, token);

        // Combine schema with prefill data for the form
        const renderData = {
          ...schema,
          prefill: prefill || {},
        };

        // Load UI HTML for legacy hosts that use UIResourceRenderer
        const htmlPath = path.join(__dirname, "ui", "form.html");
        let html = await fs.readFile(htmlPath, "utf-8");

        // Inject schema data directly into HTML for self-contained rendering
        const schemaScript = `<script>window.FORM_SCHEMA = ${JSON.stringify(renderData)};</script>`;
        html = html.replace("</head>", `${schemaScript}</head>`);

        return {
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            // Inline resource for legacy hosts (UIResourceRenderer pattern)
            {
              type: "resource",
              resource: {
                uri: formResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
              },
            },
          ],
          // Pass schema + prefill to MCP Apps iframe via _meta
          _meta: {
            "mcpui.dev/ui-initial-render-data": renderData,
          },
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: String(error) }) },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

app.listen(PORT, () => {
  console.log(`ServiceNow MCP Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
