import { getInstanceUrl } from "./utils.js";

const SCOPE = "useraccount";

export function getAuthUrl(redirectUri: string, clientId: string): string {
  const instanceUrl = getInstanceUrl();

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPE);

  return authUrl.toString();
}

export function getTokenUrl(): string {
  return `${getInstanceUrl()}/oauth_token.do`;
}
