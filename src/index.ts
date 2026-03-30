#!/usr/bin/env node

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import cors from "cors";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { submitForm, getFormFields } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// ---------------------------------------------------------------------------
// HTML Form Utilities
// ---------------------------------------------------------------------------

let cachedFormHtml: string | null = null;

async function getFormHtml(): Promise<string> {
  if (!cachedFormHtml) {
    cachedFormHtml = await fs.readFile(
      path.join(__dirname, "ui", "form.html"),
      "utf-8",
    );
  }
  return cachedFormHtml;
}

function safeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/'/g, "\\u0027")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function encodeForDataAttr(data: unknown): string {
  return JSON.stringify(data)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Express App Setup
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// MCP Endpoint
// ---------------------------------------------------------------------------

app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    // Return 401 to trigger OAuth flow in MCP clients
    if (!token) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized - OAuth authentication required",
        },
        id: null,
      });
      return;
    }

    const server = createMcpServer(token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    }
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

function createMcpServer(token: string): McpServer {
  const server = new McpServer({
    name: "servicenow-mcp-server",
    version: "1.0.0",
  });

  const formResourceUri = "ui://servicenow/form";

  // Register form UI resource
  registerAppResource(
    server,
    formResourceUri,
    formResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: formResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getFormHtml(),
        },
      ],
    }),
  );

  // Tool: Submit a record to ServiceNow
  server.registerTool(
    "submit_form",
    {
      title: "Submit Form",
      description: "Submit a record to a ServiceNow table.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        data: z
          .record(z.string(), z.unknown())
          .describe("The form data to submit"),
      },
    },
    async ({ table, data }) => {
      try {
        const result = await submitForm(
          table,
          data as Record<string, unknown>,
          token,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Get form fields for a table
  server.registerTool(
    "get_form_fields",
    {
      title: "Get Form Fields",
      description: "Get the available fields for a ServiceNow table.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
      },
    },
    async ({ table }) => {
      try {
        const schema = await getFormFields(table, token);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(schema, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Render interactive form
  registerAppTool(
    server,
    "render_form",
    {
      title: "Render Form",
      description:
        "Display an interactive form to create a ServiceNow record. Optionally call get_form_fields first to see available fields.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        prefill: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional key-value pairs to pre-fill"),
      },
      _meta: { ui: { resourceUri: formResourceUri } },
    },
    async ({ table, prefill }) => {
      try {
        const schema = await getFormFields(table, token);
        const renderData = { ...schema, prefill: prefill || {} };
        let html = await getFormHtml();
        html = html.replace(
          '<div class="form-container">',
          `<div class="form-container" data-schema="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.FORM_SCHEMA = ${safeJsonForHtml(renderData)};</script></head>`,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            {
              type: "resource",
              resource: {
                uri: formResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
              },
            },
          ],
          _meta: { "mcpui.dev/ui-initial-render-data": renderData },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`ServiceNow MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
});
