import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ServerSentEventStream } from "@std/http";

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 */
export class SSEServerTransport implements Transport {
  private _controller?: ReadableStreamDefaultController;
  private _stream?: ReadableStream;
  private _sessionId: string;
  private _connected: boolean = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private _endpoint: string) {
    this._sessionId = crypto.randomUUID();
  }

  /**
   * Creates an SSE response that can be returned from a Hono route
   */
  createSSEResponse(): Response {
    this._stream = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this._connected = false;
        this._controller = undefined;
        this.onclose?.();
      },
    }).pipeThrough(new ServerSentEventStream());

    return new Response(this._stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  /**
   * Implements Transport.start()
   */
  start(): Promise<void> {
    if (!this._controller) {
      throw new Error("SSEServerTransport not initialized!");
    }

    this._controller.enqueue({
      event: "endpoint",
      data: `${this._endpoint}?sessionId=${this._sessionId}`,
      id: Date.now().toString(),
    });

    this._connected = true;
    return Promise.resolve();
  }

  /**
   * Handles incoming POST messages from Hono routes
   */
  async handlePostMessage(request: Request): Promise<Response> {
    if (!this._connected) {
      return new Response("SSE connection not established", { status: 500 });
    }

    try {
      const contentTypeHeader = request.headers.get("content-type");
      if (!contentTypeHeader?.includes("application/json")) {
        throw new Error("Unsupported content-type: Expected application/json");
      }

      const body = await request.json();
      await this.handleMessage(body);

      return new Response("Accepted", { status: 202 });
    } catch (error) {
      this.onerror?.(error as Error);
      return new Response(String(error), { status: 400 });
    }
  }

  private handleMessage(message: unknown): Promise<void> {
    try {
      const parsedMessage = JSONRPCMessageSchema.parse(message);
      this.onmessage?.(parsedMessage);
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this._controller?.close();
    this._controller = undefined;
    this._connected = false;
    this.onclose?.();
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (!this._connected || !this._controller) {
      throw new Error("Not connected");
    }

    this._controller.enqueue({
      event: "message",
      data: JSON.stringify(message),
      id: Date.now().toString(),
    });

    return Promise.resolve();
  }

  get sessionId(): string {
    return this._sessionId;
  }
}
