import * as crypto from "crypto";
import { getInstanceUrl } from "./utils.js";

const SCOPE = "useraccount";

export function getAuthUrl(
  redirectUri: string,
  clientId: string,
  state?: string,
): string {
  const instanceUrl = getInstanceUrl();
  const finalState = state || crypto.randomBytes(16).toString("hex");

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("state", finalState);

  return authUrl.toString();
}

export function getTokenUrl(): string {
  return `${getInstanceUrl()}/oauth_token.do`;
}
