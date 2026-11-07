import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MURAL_CONFIG } from "../config.ts";
import type { MuralAuth } from "./auth.ts";
import type { StickyStyle } from "./layout.ts";

/**
 * Mural board access via the vendored mcp-mural MCP server (`uv run mural-mcp`),
 * spawned as a stdio child process. Method shapes mirror the REST client this
 * replaced, so the projector is unaware of the transport.
 *
 * Two things make this safe to sit under a live session:
 *
 * - **Lazy, fail-soft spawn.** The subprocess starts on first use, never at import.
 *   A missing `uv`, a broken venv, or a dead pipe surfaces as a MuralApiError, which
 *   the projector already turns into its degraded state — the session keeps running.
 * - **Host-owned session state.** mcp-mural resolves its target board and credentials
 *   from module-level state, so `set_target` / `set_auth` are pushed before each call
 *   whose values changed. MuralAuth stays the single OAuth owner; access tokens live
 *   ~15 min, so the token is re-pushed whenever it rotates.
 */

export class MuralApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MuralApiError";
  }
}

export interface StickyCreate {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: "rectangle";
  text: string;
  rotation?: number;
  style?: StickyStyle;
  /** Parent area id. When set, x/y are area-relative rather than board-absolute. */
  parentId?: string;
}

export interface AreaCreate {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  style?: { borderColor?: string };
}

export interface CreatedWidget {
  id: string;
}

/** Mural's HTTP status is not carried over MCP; map what we can from the message. */
function statusFromMessage(message: string): number {
  const m = message.match(/Mural API error (\d{3})/);
  return m ? Number(m[1]) : 500;
}

export class MuralMcp {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private target: string | null = null;
  private pushedToken: string | null = null;

  constructor(
    private readonly auth: MuralAuth,
    private readonly repoPath = MURAL_CONFIG.mcpRepoPath,
  ) {}

  /** Drop the subprocess. Safe to call when never started. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.target = null;
    this.pushedToken = null;
    await client?.close().catch(() => {
      /* already dead — nothing to reclaim */
    });
  }

  async getMural(
    muralId: string,
  ): Promise<{ id: string; title?: string; embedLink?: string }> {
    return this.call("tool_get_mural", { mural_id: muralId }, muralId);
  }

  /** Batch-create sticky notes in one API call. Returns widgets in input order. */
  async createStickies(muralId: string, items: StickyCreate[]): Promise<CreatedWidget[]> {
    if (items.length === 0) return [];
    const result = await this.call<CreatedWidget[]>(
      "tool_create_cards_bulk",
      { cards: items.map(toCard) },
      muralId,
    );
    return Array.isArray(result) ? result : [result];
  }

  async createArea(muralId: string, area: AreaCreate): Promise<CreatedWidget> {
    return this.call(
      "tool_create_frame",
      {
        name: area.title,
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        border_color: area.style?.borderColor,
      },
      muralId,
    );
  }

  async updateSticky(
    muralId: string,
    widgetId: string,
    patch: Partial<StickyCreate>,
  ): Promise<void> {
    await this.call(
      "tool_update_card",
      {
        card_id: widgetId,
        text: patch.text,
        color: patch.style?.backgroundColor,
        italic: patch.style?.italic,
        x: patch.x,
        y: patch.y,
        width: patch.width,
        height: patch.height,
        frame_id: patch.parentId,
        rotation: patch.rotation,
      },
      muralId,
    );
  }

  async updateArea(muralId: string, widgetId: string, patch: Partial<AreaCreate>): Promise<void> {
    await this.call(
      "tool_update_frame",
      {
        frame_id: widgetId,
        name: patch.title,
        x: patch.x,
        y: patch.y,
        width: patch.width,
        height: patch.height,
        border_color: patch.style?.borderColor,
      },
      muralId,
    );
  }

  /** Arrow between two widgets. Single-create — there is no batch endpoint. */
  async createConnector(
    muralId: string,
    fromWidgetId: string,
    toWidgetId: string,
    label?: string,
  ): Promise<CreatedWidget> {
    return this.call(
      "tool_create_connector",
      { from_id: fromWidgetId, to_id: toWidgetId, label },
      muralId,
    );
  }

  /** Delete any widget — sticky, area, or connector. */
  async deleteWidget(muralId: string, widgetId: string): Promise<void> {
    await this.call("tool_delete_widget", { widget_id: widgetId }, muralId);
  }

  // ---- transport ------------------------------------------------------------

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    // Single-flight: concurrent first calls must not spawn two subprocesses.
    this.connecting ??= (async () => {
      const client = new Client({ name: "specstorming-mural", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: "uv",
        args: ["run", "mural-mcp"],
        cwd: this.repoPath,
      });
      await client.connect(transport);
      this.client = client;
      // A fresh process has neither target nor token.
      this.target = null;
      this.pushedToken = null;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Push target board and credentials, then invoke `name`. */
  private async call<T>(
    name: string,
    args: Record<string, unknown>,
    muralId: string,
  ): Promise<T> {
    try {
      await this.connect();
      if (this.target !== muralId) {
        await this.invoke("tool_set_target", { mural_id: muralId });
        this.target = muralId;
      }
      const token = await this.auth.accessToken();
      if (this.pushedToken !== token) {
        await this.invoke("tool_set_auth", { access_token: token });
        this.pushedToken = token;
      }
      return await this.invoke<T>(name, args);
    } catch (err) {
      if (err instanceof MuralApiError) throw err;
      // Transport-level failure (no uv, broken pipe, killed child). Drop the client
      // so the next pass respawns instead of retrying against a dead process.
      void this.close();
      const detail = err instanceof Error ? err.message : String(err);
      throw new MuralApiError(503, `mural mcp transport failed (${name}): ${detail}`);
    }
  }

  private async invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
    // Undefined args would serialize as JSON null and overwrite fields the caller
    // meant to leave alone — mcp-mural treats null as "clear this".
    const params = Object.fromEntries(
      Object.entries(args).filter(([, v]) => v !== undefined),
    );
    const result = await this.client!.callTool({ name, arguments: params });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0];
    const text = content?.type === "text" ? (content.text ?? "") : "";

    // FastMCP reports tool errors as plain text rather than a protocol error, so a
    // failed call looks like a successful one until the payload is inspected.
    if (result.isError || text.startsWith("Error")) {
      throw new MuralApiError(statusFromMessage(text), `${name} → ${text.slice(0, 300)}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MuralApiError(500, `${name} → unparseable response: ${text.slice(0, 200)}`);
    }
  }
}

/** Projector sticky → mcp-mural card. Colour carries our hex palette through. */
function toCard(s: StickyCreate): Record<string, unknown> {
  return {
    text: s.text,
    color: s.style?.backgroundColor ?? "yellow",
    italic: s.style?.italic,
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    frame_id: s.parentId,
    rotation: s.rotation,
  };
}
