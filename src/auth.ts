import * as crypto from "crypto";
import { getInstanceUrl, getBaseUrl } from "./utils.js";

// ServiceNow OAuth configuration
const CLIENT_ID = "42093b633ebb424abb79ee9a89aed6f3";
const SCOPE = "useraccount";

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  instance: string;
}

// In-memory token storage
let tokens: TokenData | null = null;

// PKCE state for pending auth flows
let pendingAuth: { verifier: string; state: string } | null = null;

function getRedirectUri(): string {
  return `${getBaseUrl()}/callback`;
}

export function getAuthUrl(): string {
  const instanceUrl = getInstanceUrl();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  pendingAuth = { verifier, state };

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", getRedirectUri());
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  return authUrl.toString();
}

export async function handleCallback(
  code: string,
  state: string,
): Promise<void> {
  if (!pendingAuth || pendingAuth.state !== state) {
    throw new Error("Invalid state parameter");
  }

  const instanceUrl = getInstanceUrl();
  const tokenUrl = `${instanceUrl}/oauth_token.do`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: getRedirectUri(),
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
  };

  pendingAuth = null;
  console.log("OAuth tokens acquired successfully");
}

async function refreshAccessToken(): Promise<boolean> {
  if (!tokens?.refresh_token) return false;

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
