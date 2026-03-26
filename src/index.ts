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
  getAuthUrl,
  handleCallback,
  isAuthenticated,
} from "./auth.js";
import { submitForm, getFormFields } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Cache form HTML at startup to avoid repeated file reads
let cachedFormHtml: string | null = null;

async function getFormHtml(): Promise<string> {
  if (!cachedFormHtml) {
    const htmlPath = path.join(__dirname, "ui", "form.html");
    cachedFormHtml = await fs.readFile(htmlPath, "utf-8");
  }
  return cachedFormHtml;
}

/**
 * Safely encode JSON for embedding in HTML script tags.
 * Escapes characters that could break out of script context.
 */
function safeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/'/g, "\\u0027")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Encode data for use in HTML data attributes.
 */
function encodeForDataAttr(data: unknown): string {
  return JSON.stringify(data)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    const clientId = req.query.client_id as string | undefined;
    const finalRedirect = req.query.final_redirect as string | undefined;
    const authUrl = getAuthUrl(clientId, finalRedirect);
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
    const finalRedirect = await handleCallback(code as string, state as string);
    if (finalRedirect) {
      res.redirect(finalRedirect);
    } else {
      res.send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>Successfully authenticated with ServiceNow</h1>
            <p>You can now use the MCP server.</p>
          </body>
        </html>
      `);
    }
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
      const html = await getFormHtml();
      return {
        contents: [
          { uri: formResourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
        ],
      };
    },
  );

  // submit_form: Submits data to ServiceNow (used by form UI or directly by LLM)
  server.registerTool(
    "submit_form",
    {
      title: "Submit Form",
      description:
        "Submit a record to a ServiceNow table. Can be called directly with data, or used internally by the form UI.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        data: z
          .record(z.string(), z.unknown())
          .describe("The form data to submit"),
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
                text: JSON.stringify({ error: "Not authenticated" }),
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
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // get_form_fields: Returns field schema only (no UI) - useful for LLM context
  server.registerTool(
    "get_form_fields",
    {
      title: "Get Form Fields",
      description:
        "Get the available fields for a ServiceNow table. Returns field names, types, and constraints. Use this to understand what data can be submitted to a table.",
      inputSchema: {
        table: z
          .string()
          .describe(
            "The ServiceNow table name (e.g., 'incident', 'sc_request', 'task', 'change_request')",
          ),
      },
    },
    async ({ table }) => {
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

        const schema = await getFormFields(table, token);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(schema, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching form fields: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // render_form: Shows interactive UI form for creating records
  registerAppTool(
    server,
    "render_form",
    {
      title: "Render Form",
      description:
        "Display an interactive form to create a record in a ServiceNow table. Use the prefill parameter to pre-populate form fields with data extracted from the conversation context.",
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

        // Load cached UI HTML
        let html = await getFormHtml();

        // Inject schema data using BOTH methods for maximum compatibility:
        // 1. Inline script (works when CSP allows inline scripts)
        // 2. Data attribute (works when CSP blocks inline scripts)
        const safeScript = `<script>window.FORM_SCHEMA = ${safeJsonForHtml(renderData)};</script>`;
        const dataAttr = `data-schema="${encodeForDataAttr(renderData)}"`;

        // Add data attribute to form container for CSP-restricted environments
        html = html.replace(
          '<div class="form-container">',
          `<div class="form-container" ${dataAttr}>`,
        );
        // Also inject inline script for environments that support it
        html = html.replace("</head>", `${safeScript}</head>`);

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
