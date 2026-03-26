import * as crypto from "crypto";
import { getInstanceUrl, getBaseUrl } from "./utils.js";

const SCOPE = "useraccount";

let pendingAuth: {
  verifier: string;
  state: string;
  clientId: string;
  finalRedirect: string;
} | null = null;

export function getAuthUrl(clientId: string, finalRedirect: string): string {
  const instanceUrl = getInstanceUrl();
  const baseUrl = getBaseUrl();

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  pendingAuth = { verifier, state, clientId, finalRedirect };

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", `${baseUrl}/callback`);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return authUrl.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  finalRedirect: string;
}

export async function handleCallback(
  code: string,
  state: string,
): Promise<TokenResult> {
  if (!pendingAuth || pendingAuth.state !== state) {
    throw new Error("Invalid state");
  }

  const instanceUrl = getInstanceUrl();
  const baseUrl = getBaseUrl();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: pendingAuth.clientId,
    code,
    redirect_uri: `${baseUrl}/callback`,
    code_verifier: pendingAuth.verifier,
  });

  const response = await fetch(`${instanceUrl}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${await response.text()}`);
  }

  const data = await response.json();
  const result: TokenResult = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 1800,
    finalRedirect: pendingAuth.finalRedirect,
  };

  pendingAuth = null;
  return result;
}
