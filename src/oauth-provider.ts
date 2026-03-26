import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomUUID } from "node:crypto";
import { getInstanceUrl, getBaseUrl } from "./utils.js";

// In-memory stores (use Redis/DB in production)
const registeredClients = new Map<string, OAuthClientInformationFull>();
const authorizationSessions = new Map<
  string,
  {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    scopes?: string[];
    state?: string;
  }
>();

// ServiceNow OAuth configuration from environment
function getServiceNowOAuthConfig() {
  const clientId = process.env.SERVICENOW_CLIENT_ID;
  const clientSecret = process.env.SERVICENOW_CLIENT_SECRET;
  if (!clientId) {
    throw new Error("SERVICENOW_CLIENT_ID environment variable is required");
  }
  return { clientId, clientSecret };
}

class ServiceNowClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return registeredClients.get(clientId);
  }

  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): OAuthClientInformationFull {
    const clientId = `mcp_${randomUUID()}`;
    const clientIdIssuedAt = Math.floor(Date.now() / 1000);

    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: clientIdIssuedAt,
      // Public clients (PKCE) don't need a secret
    };

    registeredClients.set(clientId, fullClient);
    console.log(`[OAuth] Registered new client: ${clientId}`);
    return fullClient;
  }
}

export class ServiceNowOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new ServiceNowClientsStore();

  // Let ServiceNow handle PKCE validation
  skipLocalPkceValidation = true;

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const { clientId } = getServiceNowOAuthConfig();
    const instanceUrl = getInstanceUrl();
    const baseUrl = getBaseUrl();

    // Generate a unique session ID to track this authorization
    const sessionId = randomUUID();

    // Store the authorization session
    authorizationSessions.set(sessionId, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes,
      state: params.state,
    });

    // Build ServiceNow authorization URL
    // We use our callback URL, then redirect back to the client
    const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", `${baseUrl}/oauth/callback`);
    authUrl.searchParams.set("state", sessionId);
    if (params.scopes?.length) {
      authUrl.searchParams.set("scope", params.scopes.join(" "));
    }
    // Pass PKCE to ServiceNow
    authUrl.searchParams.set("code_challenge", params.codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    console.log(
      `[OAuth] Redirecting to ServiceNow auth: ${authUrl.toString()}`,
    );
    res.redirect(authUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    // The authorization code from ServiceNow won't directly map to our sessions
    // Since skipLocalPkceValidation is true, this won't be called for local validation
    // But we need to return something for the interface
    const session = Array.from(authorizationSessions.values()).find(
      (s) => s.codeChallenge,
    );
    return session?.codeChallenge || "";
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret } = getServiceNowOAuthConfig();
    const instanceUrl = getInstanceUrl();
    const baseUrl = getBaseUrl();

    const tokenUrl = `${instanceUrl}/oauth_token.do`;
    const params = new URLSearchParams();
    params.set("grant_type", "authorization_code");
    params.set("code", authorizationCode);
    params.set("redirect_uri", `${baseUrl}/oauth/callback`);
    params.set("client_id", clientId);
    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }
    if (codeVerifier) {
      params.set("code_verifier", codeVerifier);
    }

    console.log(`[OAuth] Exchanging code at ${tokenUrl}`);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[OAuth] Token exchange failed: ${response.status} ${errorText}`,
      );
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const tokens = await response.json();
    console.log(`[OAuth] Token exchange successful`);

    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type || "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret } = getServiceNowOAuthConfig();
    const instanceUrl = getInstanceUrl();

    const tokenUrl = `${instanceUrl}/oauth_token.do`;
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
    params.set("client_id", clientId);
    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }
    if (scopes?.length) {
      params.set("scope", scopes.join(" "));
    }

    console.log(`[OAuth] Refreshing token at ${tokenUrl}`);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[OAuth] Token refresh failed: ${response.status} ${errorText}`,
      );
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const tokens = await response.json();
    console.log(`[OAuth] Token refresh successful`);

    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type || "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // For ServiceNow, we trust the token if it was issued by us
    // In production, you'd want to introspect with ServiceNow or decode JWT
    return {
      token,
      clientId: "servicenow",
      scopes: ["useraccount"],
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // ServiceNow doesn't have a standard revocation endpoint
    // Just acknowledge the request
    console.log(`[OAuth] Token revocation requested (no-op for ServiceNow)`);
  }
}

// Helper to get session by state
export function getAuthorizationSession(sessionId: string) {
  return authorizationSessions.get(sessionId);
}

// Helper to delete session
export function deleteAuthorizationSession(sessionId: string) {
  authorizationSessions.delete(sessionId);
}
