// deno-lint-ignore-file no-explicit-any
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ServerSentEventStream } from "@std/http/server-sent-event-stream";

// Options for session management and response mode
export interface HttpServerTransportOptions {
  sessionIdGenerator?: () => string;
  onsessioninitialized?: (sessionId: string) => void;
  enableJsonResponse?: boolean;
}

export class HttpServerTransport implements Transport {
  public sessionId?: string;
  private sessionIdGenerator?: () => string;
  private onsessioninitialized?: (sessionId: string) => void;
  private enableJsonResponse: boolean;
  private initialized = false;
  private sseController?: ReadableStreamDefaultController<any>;
  private sseStreamActive = false;
  private responseResolver?: (response: Response) => void;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: HttpServerTransportOptions = {}) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this.onsessioninitialized = options.onsessioninitialized;
    this.enableJsonResponse = options.enableJsonResponse ?? false;
  }

  async handleMessage(request: Request): Promise<Response> {
    try {
      // Validate Accept header
      const accept = request.headers.get("accept") || "";
      if (!accept.includes("application/json") && !accept.includes("text/event-stream")) {
        return this.jsonRpcError(-32000, "Not Acceptable: Accept must include application/json or text/event-stream", 406);
      }

      // Validate Content-Type for POST
      if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return this.jsonRpcError(-32000, "Unsupported Media Type: Content-Type must be application/json", 415);
        }
      }

      // Session validation (if enabled)
      if (this.sessionIdGenerator) {
        if (!this.initialized && request.method !== "POST") {
          return this.jsonRpcError(-32000, "Bad Request: Server not initialized", 400);
        }
        if (this.initialized && request.method !== "POST") {
          const sessionId = request.headers.get("mcp-session-id");
          if (!sessionId) {
            return this.jsonRpcError(-32000, "Bad Request: Mcp-Session-Id header is required", 400);
          }
          if (sessionId !== this.sessionId) {
            return this.jsonRpcError(-32001, "Session not found", 404);
          }
        }
      }

      if (request.method === "POST") {
        return await this.handlePost(request);
      } else if (request.method === "GET") {
        return await this.handleGet(request);
      } else if (request.method === "DELETE") {
        return await this.handleDelete(request);
      } else {
        return this.jsonRpcError(-32000, "Method not allowed.", 405, { "Allow": "GET, POST, DELETE" });
      }
    } catch (err) {
      this.onerror?.(err as Error);
      return this.jsonRpcError(-32603, "Internal error", 500, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  private async handlePost(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch (err) {
      return this.jsonRpcError(-32700, "Parse error", 400, undefined, String(err));
    }

    // Batch or single
    let messages: JSONRPCMessage[];
    try {
      messages = Array.isArray(body)
        ? body.map((msg: any) => JSONRPCMessageSchema.parse(msg))
        : [JSONRPCMessageSchema.parse(body)];
    } catch (err) {
      return this.jsonRpcError(-32600, "Invalid Request: JSON-RPC message validation failed", 400, undefined, String(err));
    }

    // Initialization
    const isInit = messages.some((msg) => "method" in msg && typeof msg.method === "string" && msg.method.endsWith("/initialize"));
    if (isInit) {
      if (this.initialized && this.sessionId !== undefined) {
        return this.jsonRpcError(-32600, "Invalid Request: Server already initialized", 400);
      }
      if (messages.length > 1) {
        return this.jsonRpcError(-32600, "Invalid Request: Only one initialization request is allowed", 400);
      }
      this.sessionId = this.sessionIdGenerator?.();
      this.initialized = true;
      if (this.sessionId && this.onsessioninitialized) {
        this.onsessioninitialized(this.sessionId);
      }
    } else if (this.sessionIdGenerator && !this.validateSessionHeader(request)) {
      return this.jsonRpcError(-32000, "Bad Request: Mcp-Session-Id header is required", 400);
    }

    // Handle messages
    for (const msg of messages) {
      this.onmessage?.(msg);
    }

    // Streaming or JSON response
    if (this.enableJsonResponse) {
      // Wait for send() to resolve the response
      return await new Promise<Response>((resolve) => {
        this.responseResolver = resolve;
      });
    } else {
      // SSE streaming
      return this.createStreamingResponse();
    }
  }

  private handleGet(_request: Request): Promise<Response> {
    // Only allow one SSE stream at a time
    if (this.sseStreamActive) {
      return Promise.resolve(this.jsonRpcError(-32000, "Conflict: Only one SSE stream is allowed per session", 409));
    }
    this.sseStreamActive = true;
    return Promise.resolve(this.createStreamingResponse());
  }

  private async handleDelete(_request: Request): Promise<Response> {
    await this.close();
    return new Response(null, { status: 200 });
  }

  private validateSessionHeader(request: Request): boolean {
    const sessionId = request.headers.get("mcp-session-id");
    return !!sessionId && sessionId === this.sessionId;
  }

  private createStreamingResponse(): Response {
    const stream = new ReadableStream<any>({
      start: (controller) => {
        this.sseController = controller;
      },
      cancel: () => {
        this.sseController = undefined;
        this.sseStreamActive = false;
        this.onclose?.();
      },
    });
    return new Response(stream.pipeThrough(new ServerSentEventStream()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    // Streaming
    if (this.sseController) {
      this.sseController.enqueue({
        event: "message",
        data: JSON.stringify(message),
        id: Date.now().toString(),
      } as any); // ServerSentEventStream expects this shape
    } else if (this.responseResolver) {
      // JSON response
      this.responseResolver(
        new Response(JSON.stringify(message), {
          headers: {
            "Content-Type": "application/json",
            ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          },
        })
      );
      this.responseResolver = undefined;
    }
    return Promise.resolve();
  }

  async start(): Promise<void> { }
  close(): Promise<void> {
    this.sseController?.close();
    this.sseController = undefined;
    this.sseStreamActive = false;
    this.onclose?.();
    return Promise.resolve();
  }

  private jsonRpcError(
    code: number,
    message: string,
    status = 400,
    headers?: Record<string, string>,
    data?: any
  ): Response {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message, ...(data ? { data } : {}) },
        id: null,
      }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
        },
      }
    );
  }
}
