import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ServerSentEventStream } from "@std/http";

/**
 * Server transport for Stateless HTTP: this will handle messages over plain HTTP requests
 * with optional SSE upgrade for streaming responses.
 */
export class StatelessServerTransport implements Transport {
  private _controller?: ReadableStreamDefaultController;
  private _responseResolver?: (response: Response) => void;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * Creates an SSE response for streaming
   */
  private createStreamingResponse(): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this._controller = undefined;
        this.onclose?.();
      },
    }).pipeThrough(new ServerSentEventStream());

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  /**
   * Handles incoming HTTP messages
   */
  async handleMessage(request: Request): Promise<Response> {
    try {
      const contentTypeHeader = request.headers.get("content-type");
      if (!contentTypeHeader?.includes("application/json")) {
        throw new Error("Unsupported content-type: Expected application/json");
      }

      const body = await request.json();
      const message = JSONRPCMessageSchema.parse(body);

      // Handle the message
      this.onmessage?.(message);

      // Create a promise that will be resolved with the response
      const { promise, resolve } = Promise.withResolvers<Response>();
      this._responseResolver = resolve;

      // For requests that need streaming responses, immediately return SSE stream
      if (this.shouldUpgradeToStreaming(message)) {
        resolve(this.createStreamingResponse());
      }

      return promise;
    } catch (error) {
      this.onerror?.(error as Error);
      return new Response(String(error), { status: 400 });
    }
  }

  /**
   * Determines if a request should be upgraded to streaming based on message type
   */
  private shouldUpgradeToStreaming(message: JSONRPCMessage): boolean {
    console.log({ message });
    // Implement logic to determine if streaming is needed
    // For example, based on method name or parameters
    return false; // Default to non-streaming
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this._controller?.close();
    this._controller = undefined;
    this.onclose?.();
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    // If we have a controller, this is a streaming response
    if (this._controller) {
      this._controller.enqueue({
        event: "message",
        data: JSON.stringify(message),
        id: Date.now().toString(),
      });
    } else if (this._responseResolver) {
      // For non-streaming responses, resolve with a single JSON response
      this._responseResolver(
        new Response(JSON.stringify(message), {
          headers: {
            "Content-Type": "application/json",
          },
        }),
      );
      this._responseResolver = undefined;
    }

    return Promise.resolve();
  }
}
