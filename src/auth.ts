import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as os from "os";

// ServiceNow OAuth configuration (using Langdock's registered app)
const CLIENT_ID = "8f28e9ff-0dfa-42a2-8cc5-33e8b76de0c0";
const SCOPE = "useraccount";
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Token storage path
const TOKEN_FILE = path.join(os.homedir(), ".servicenow-mcp-tokens.json");

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  instance: string;
}

function getInstanceUrl(): string {
  const instance = process.env.SERVICENOW_INSTANCE;
  if (!instance) {
    throw new Error(
      "SERVICENOW_INSTANCE environment variable is required (e.g., 'company' or 'company.service-now.com')",
    );
  }
  // Handle both subdomain-only and full hostname
  const host = instance.includes(".")
    ? instance
    : `${instance}.service-now.com`;
  return `https://${host}`;
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function loadTokens(): TokenData | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      return data as TokenData;
    }
  } catch {
    // Ignore errors, treat as no tokens
  }
  return null;
}

function saveTokens(tokens: TokenData): void {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(
  tokens: TokenData,
): Promise<TokenData | null> {
  const instanceUrl = getInstanceUrl();
  const tokenUrl = `${instanceUrl}/oauth_token.do`;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: tokens.refresh_token,
  });

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      console.error("Token refresh failed:", await response.text());
      return null;
    }

    const data = await response.json();
    const newTokens: TokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in || 1800) * 1000,
      instance: tokens.instance,
    };

    saveTokens(newTokens);
    return newTokens;
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

export async function getAuthToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) {
    return null;
  }

  // Check if token is expired (with 60 second buffer)
  if (Date.now() >= tokens.expires_at - 60000) {
    const refreshed = await refreshAccessToken(tokens);
    return refreshed?.access_token || null;
  }

  return tokens.access_token;
}

async function performOAuthFlow(): Promise<TokenData> {
  const instanceUrl = getInstanceUrl();
  const { verifier, challenge } = generatePKCE();

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Start local server to receive callback
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authorization Failed</h1><p>${error}</p></body></html>`,
          );
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Missing authorization code</h1></body></html>",
          );
          server.close();
          reject(new Error("Missing authorization code"));
          return;
        }

        // Exchange code for tokens
        try {
          const tokenUrl = `${instanceUrl}/oauth_token.do`;
          const body = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          });

          const tokenResponse = await fetch(tokenUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
          });

          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(
              `<html><body><h1>Token Exchange Failed</h1><p>${errorText}</p></body></html>`,
            );
            server.close();
            reject(new Error(`Token exchange failed: ${errorText}`));
            return;
          }

          const data = await tokenResponse.json();
          const tokens: TokenData = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + (data.expires_in || 1800) * 1000,
            instance: instanceUrl,
          };

          saveTokens(tokens);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Successfully authenticated with ServiceNow</h1>
                <p>You can close this window and return to Claude.</p>
              </body>
            </html>
          `);

          server.close();
          resolve(tokens);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>Error</h1><p>${err}</p></body></html>`);
          server.close();
          reject(err);
        }
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.error(`\n========================================`);
      console.error(`ServiceNow Authentication Required`);
      console.error(`========================================`);
      console.error(`\nPlease open this URL in your browser:\n`);
      console.error(authUrl.toString());
      console.error(`\n========================================\n`);

      // Try to open browser automatically
      const { exec } = require("child_process");
      const openCommand =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      exec(`${openCommand} "${authUrl.toString()}"`);
    });

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close();
        reject(new Error("OAuth flow timed out"));
      },
      5 * 60 * 1000,
    );
  });
}

export async function ensureAuthenticated(): Promise<void> {
  const token = await getAuthToken();
  if (!token) {
    console.error(
      "No valid authentication token found. Starting OAuth flow...",
    );
    await performOAuthFlow();
  }
}
