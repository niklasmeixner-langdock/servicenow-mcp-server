#!/usr/bin/env node

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const app = express();

// CORS headers for MCP clients
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

// MCP endpoint
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    // Ensure authenticated before handling request
    await ensureAuthenticated();

    // Parse body manually (MCP transport needs raw control)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();
    const parsedBody = body ? JSON.parse(body) : {};

    // Create MCP server instance
    const server = new McpServer({
      name: "servicenow-mcp-server",
      version: "1.0.0",
    });

    // Register tools and UI resources
    await registerTools(server);

    // Create transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);

    // Handle the request
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error" });
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

async function registerTools(server: McpServer) {
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

  // Register the get_form_fields tool with UI metadata linking to form resource
  registerAppTool(
    server,
    "get_form_fields",
    {
      title: "Get Form Fields",
      description:
        "Fetch the form schema for a ServiceNow table and display an interactive form UI.",
      inputSchema: {
        table: z
          .string()
          .describe(
            "The ServiceNow table name (e.g., 'incident', 'sc_request', 'task', 'change_request')",
          ),
      },
      _meta: { ui: { resourceUri: formResourceUri } }, // Links this tool to its UI resource
    },
    async ({ table }) => {
      try {
        const token = await getAuthToken();
        if (!token) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Not authenticated. Please run the OAuth flow first.",
                }),
              },
            ],
            isError: true,
          };
        }

        const schema = await getFormFields(table, token);

        // Return the schema as JSON - MCP UI will pass this to form.html
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(schema),
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
}

app.listen(PORT, () => {
  console.log(`ServiceNow MCP Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
