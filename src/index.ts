#!/usr/bin/env node

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getAuthToken, ensureAuthenticated } from "./auth.js";
import { submitForm, getFormFields } from "./client.js";

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

    // Register tools
    registerTools(server);

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
  res.json({ status: "ok" });
});

function registerTools(server: McpServer) {
  // Register the submit_form tool
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

  // Register the get_form_fields tool
  server.registerTool(
    "get_form_fields",
    {
      title: "Get Form Fields",
      description:
        "Fetch the form schema for a ServiceNow table. Returns field definitions including types, labels, required status, and choice options. Use this to understand what fields are available before submitting a form.",
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
}

app.listen(PORT, () => {
  console.log(`ServiceNow MCP Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
