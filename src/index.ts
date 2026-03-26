#!/usr/bin/env node

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
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
import { submitForm, getFormFields } from "./client.js";
import { getBaseUrl } from "./utils.js";
import {
  ServiceNowOAuthProvider,
  getAuthorizationSession,
  deleteAuthorizationSession,
} from "./oauth-provider.js";

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

// Create OAuth provider
const oauthProvider = new ServiceNowOAuthProvider();

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Install MCP auth router at root for OAuth DCR support
// This exposes: /.well-known/oauth-authorization-server, /register, /authorize, /token
const baseUrl = getBaseUrl();
console.log(`[OAuth] Setting up auth router with baseUrl: ${baseUrl}`);
const authRouter = mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(baseUrl),
  baseUrl: new URL(baseUrl),
  scopesSupported: ["useraccount"],
  resourceName: "ServiceNow MCP Server",
});
console.log(`[OAuth] Auth router created successfully`);
app.use("/", authRouter);

// Test route to verify Express routing works
app.get("/test-routes", (_req, res) => {
  res.json({ status: "ok", message: "Express routing works" });
});

// OAuth callback from ServiceNow - redirects back to the MCP client
app.get("/oauth/callback", (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;

  console.log("[OAuth] Callback received:", { code: !!code, state, error });

  if (error) {
    console.error(
      `[OAuth] Error from ServiceNow: ${error} - ${error_description}`,
    );
    res.status(400).json({ error, error_description });
    return;
  }

  if (!state || typeof state !== "string") {
    res.status(400).json({ error: "missing_state" });
    return;
  }

  const session = getAuthorizationSession(state);
  if (!session) {
    res.status(400).json({ error: "invalid_state" });
    return;
  }

  // Build redirect URL back to the MCP client with the authorization code
  const redirectUrl = new URL(session.redirectUri);
  if (code) {
    redirectUrl.searchParams.set("code", code as string);
  }
  if (session.state) {
    redirectUrl.searchParams.set("state", session.state);
  }

  // Clean up session
  deleteAuthorizationSession(state);

  console.log(`[OAuth] Redirecting to client: ${redirectUrl.toString()}`);
  res.redirect(redirectUrl.toString());
});

// MCP endpoint - uses Authorization header with Bearer token
app.all("/mcp", async (req: Request, res: Response) => {
  console.log("=== MCP Request ===");
  console.log("Method:", req.method);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("===================");

  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    console.log("Token present:", !!token);

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
    console.log("=== MCP Request completed successfully ===");
  } catch (error) {
    console.error("=== MCP Error ===");
    console.error("Error:", error);
    console.error("=================");
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
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
      },
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

app.listen(PORT, () => {
  console.log(`ServiceNow MCP Server running on port ${PORT}`);
  console.log(`[OAuth] Auth routes should be available at:`);
  console.log(`  - GET /.well-known/oauth-authorization-server`);
  console.log(`  - POST /register`);
  console.log(`  - GET /authorize`);
  console.log(`  - POST /token`);
});
