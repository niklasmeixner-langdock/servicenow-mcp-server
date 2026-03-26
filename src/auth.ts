import * as crypto from "crypto";
import { getInstanceUrl, getBaseUrl } from "./utils.js";

const SCOPE = "useraccount";

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  instance: string;
  clientId: string;
}

// In-memory token storage
let tokens: TokenData | null = null;

// PKCE state for pending auth flows
let pendingAuth: {
  verifier: string;
  state: string;
  redirectUri: string;
  clientId: string;
  finalRedirect?: string;
} | null = null;

function getDefaultRedirectUri(): string | null {
  try {
    return `${getBaseUrl()}/callback`;
  } catch {
    return null;
  }
}

export function getAuthUrl(clientId?: string, finalRedirect?: string): string {
  const instanceUrl = getInstanceUrl();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  // redirect_uri must be MCP server's callback (it has the PKCE verifier)
  const redirectUri = getDefaultRedirectUri();
  if (!redirectUri) {
    throw new Error("BASE_URL env required for OAuth callback");
  }

  const resolvedClientId = clientId || process.env.SERVICENOW_CLIENT_ID;
  if (!resolvedClientId) {
    throw new Error("client_id is required");
  }

  pendingAuth = {
    verifier,
    state,
    redirectUri,
    clientId: resolvedClientId,
    finalRedirect,
  };

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", resolvedClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  return authUrl.toString();
}

export function getPendingRedirectUri(): string | null {
  return pendingAuth?.redirectUri || null;
}

export async function handleCallback(
  code: string,
  state: string,
): Promise<string | null> {
  if (!pendingAuth || pendingAuth.state !== state) {
    throw new Error("Invalid state parameter");
  }

  const instanceUrl = getInstanceUrl();
  const tokenUrl = `${instanceUrl}/oauth_token.do`;
  const finalRedirect = pendingAuth.finalRedirect;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: pendingAuth.clientId,
    code,
    redirect_uri: pendingAuth.redirectUri,
    code_verifier: pendingAuth.verifier,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = await response.json();
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 1800) * 1000,
    instance: instanceUrl,
    clientId: pendingAuth.clientId,
  };

  pendingAuth = null;
  return finalRedirect || null;
}

async function refreshAccessToken(): Promise<boolean> {
  if (!tokens?.refresh_token) return false;

  const instanceUrl = getInstanceUrl();
  const tokenUrl = `${instanceUrl}/oauth_token.do`;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: tokens.clientId,
    refresh_token: tokens.refresh_token,
  });

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      console.error("Token refresh failed:", await response.text());
      return false;
    }

    const data = await response.json();
    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in || 1800) * 1000,
      instance: tokens.instance,
      clientId: tokens.clientId,
    };

    return true;
  } catch (error) {
    console.error("Token refresh error:", error);
    return false;
  }
}

export async function getAuthToken(): Promise<string | null> {
  if (!tokens) return null;

  // Refresh if expired (with 60s buffer)
  if (Date.now() >= tokens.expires_at - 60000) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) return null;
  }

  return tokens.access_token;
}

export function isAuthenticated(): boolean {
  return tokens !== null;
}
