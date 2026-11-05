import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MURAL_CONFIG, SERVER_CONFIG } from "../config.ts";

/**
 * Mural OAuth 2.0 (Authorization Code + PKCE — Mural offers no API keys).
 * Access tokens live ~15 minutes; the reusable refresh token is applied
 * proactively (2 min before expiry) and reactively (401 → refresh, retry once).
 * Tokens are stored server-side only, under the git-ignored data/ directory.
 */

const REFRESH_MARGIN_MS = 2 * 60_000;

interface MuralTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

function tokensFile(): string {
  return join(SERVER_CONFIG.repoRoot, "data", "mural", "tokens.json");
}

export class MuralAuth {
  private tokens: MuralTokens | null = null;
  private loaded = false;
  /** OAuth state → PKCE verifier for in-flight authorizations. */
  private pending = new Map<string, string>();
  /** Single-flight refresh so concurrent 401s don't race the token endpoint. */
  private refreshing: Promise<void> | null = null;

  constructor(private readonly cfg = MURAL_CONFIG) {}

  get configured(): boolean {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret);
  }

  async connected(): Promise<boolean> {
    await this.load();
    return this.tokens !== null;
  }

  /** Build the Mural authorize URL for a new PKCE flow. */
  beginAuth(): string {
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, verifier);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(this.cfg.authorizeUrl);
    url.searchParams.set("client_id", this.cfg.clientId);
    url.searchParams.set("redirect_uri", this.cfg.redirectUri);
    url.searchParams.set("scope", this.cfg.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Exchange the callback code for tokens. Throws on unknown state or exchange failure. */
  async handleCallback(code: string, state: string): Promise<void> {
    const verifier = this.pending.get(state);
    if (!verifier) throw new Error("unknown or expired oauth state");
    this.pending.delete(state);
    await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.cfg.redirectUri,
    });
  }

  /** Current access token, proactively refreshed near expiry. */
  async accessToken(): Promise<string> {
    await this.load();
    if (!this.tokens) throw new Error("Mural is not connected (no tokens stored)");
    if (this.tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) await this.refresh();
    return this.tokens.accessToken;
  }

  /** Authorized fetch: bearer token attached; a 401 triggers one refresh + retry. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const doFetch = (token: string) =>
      fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    let res = await doFetch(await this.accessToken());
    if (res.status === 401) {
      await this.refresh();
      res = await doFetch(this.tokens!.accessToken);
    }
    return res;
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: this.tokens?.refreshToken ?? "",
    }).finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  private async tokenRequest(params: Record<string, string>): Promise<void> {
    const res = await fetch(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        ...params,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Mural ${params.grant_type} failed: ${res.status} ${detail}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };
    this.tokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 900) * 1000,
    };
    // Owner-only permissions: this file holds live OAuth credentials. chmod covers a
    // pre-existing file created with a wider mode (writeFile's mode only applies on create).
    const file = tokensFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(this.tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
    await chmod(file, 0o600);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.tokens = JSON.parse(await readFile(tokensFile(), "utf-8")) as MuralTokens;
    } catch {
      this.tokens = null;
    }
  }
}
