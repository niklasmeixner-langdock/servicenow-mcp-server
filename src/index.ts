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
import { getAuthUrl, handleCallback } from "./auth.js";
import { submitForm, getFormFields } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

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

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.use(cors());

app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    const server = createServer(token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res
        .status(500)
        .json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
    }
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/auth", (req, res) => {
  try {
    const clientId = req.query.client_id as string;
    const redirectUri = req.query.redirect_uri as string;

    if (!clientId || !redirectUri) {
      res.status(400).json({ error: "client_id and redirect_uri required" });
      return;
    }

    res.redirect(getAuthUrl(clientId, redirectUri));
  } catch (error) {
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Auth failed" });
  }
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`Authorization failed: ${error}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("Missing code or state");
    return;
  }

  try {
    const result = await handleCallback(code as string, state as string);
    const url = new URL(result.finalRedirect);
    url.searchParams.set("access_token", result.accessToken);
    url.searchParams.set("refresh_token", result.refreshToken);
    url.searchParams.set("expires_in", String(result.expiresIn));
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err}`);
  }
});

function createServer(token: string | null): McpServer {
  const server = new McpServer({
    name: "servicenow-mcp-server",
    version: "1.0.0",
  });
  const formResourceUri = "ui://servicenow/form";

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
      if (!token)
        return {
          content: [{ type: "text" as const, text: "Not authenticated" }],
          isError: true,
        };
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

  server.registerTool(
    "get_form_fields",
    {
      title: "Get Form Fields",
      description: "Get the available fields for a ServiceNow table.",
      inputSchema: { table: z.string().describe("The ServiceNow table name") },
    },
    async ({ table }) => {
      if (!token)
        return {
          content: [{ type: "text" as const, text: "Not authenticated" }],
          isError: true,
        };
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

  registerAppTool(
    server,
    "render_form",
    {
      title: "Render Form",
      description: "Display an interactive form to create a ServiceNow record.",
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
      if (!token)
        return {
          content: [{ type: "text", text: "Not authenticated" }],
          isError: true,
        };
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

app.listen(PORT, () =>
  console.log(`ServiceNow MCP Server running on port ${PORT}`),
);
