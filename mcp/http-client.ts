import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  auth,
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
/**
 * Configuration options for the `StatelessClientTransport`.
 */
export type HttpClientTransportOptions = {
  /**
   * An OAuth client provider to use for authentication.
   */
  authProvider?: OAuthClientProvider;

  /**
   * Customizes requests to the server.
   */
  requestInit?: RequestInit;
};

/**
 * Client transport for Stateless HTTP: this will communicate with the server using HTTP requests
 * and handle both immediate responses and streaming responses when needed.
 */
export class HttpClientTransport implements Transport {
  private _abortController?: AbortController;
  private _eventSource?: EventSource;
  private _authProvider?: OAuthClientProvider;
  private _requestInit?: RequestInit;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private _url: URL,
    opts?: HttpClientTransportOptions,
  ) {
    this._authProvider = opts?.authProvider;
    this._requestInit = opts?.requestInit;
  }

  private async _commonHeaders(): Promise<HeadersInit> {
    const headers: HeadersInit = {};
    if (this._authProvider) {
      const tokens = await this._authProvider.tokens();
      if (tokens) {
        headers["Authorization"] = `Bearer ${tokens.access_token}`;
      }
    }
    return headers;
  }

  private async _handleStreamingResponse(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        try {
          const { done, value } = await reader.read();
          if (done) break;

          // Handle potential decoding errors
          try {
            buffer += decoder.decode(value, { stream: true });
          } catch (decodeError) {
            this.onerror?.(
              new Error(`Failed to decode stream data: ${decodeError}`),
            );
            continue;
          }

          // Process complete SSE messages
          const messages = buffer.split("\n\n");
          buffer = messages.pop() || ""; // Keep incomplete message in buffer

          for (const message of messages) {
            if (!message.trim()) continue;

            try {
              const lines = message.split("\n");
              const data = lines.find((line) => line.startsWith("data: "))
                ?.slice(6);

              if (data) {
                try {
                  const parsed = JSONRPCMessageSchema.parse(JSON.parse(data));
                  this.onmessage?.(parsed);
                } catch (parseError) {
                  this.onerror?.(
                    new Error(`Failed to parse message data: ${parseError}`),
                  );
                }
              }
            } catch (messageError) {
              this.onerror?.(
                new Error(`Failed to process message: ${messageError}`),
              );
              // Continue processing other messages
              continue;
            }
          }
        } catch (readError) {
          // Handle stream read errors
          if (readError instanceof Error && readError.name === "AbortError") {
            // Expected abort, break the loop
            break;
          }
          this.onerror?.(
            new Error(`Error reading from stream: ${String(readError)}`),
          );
          // Try to continue reading if possible
          continue;
        }
      }
    } catch (error) {
      this.onerror?.(new Error(`Fatal streaming error: ${error}`));
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        console.warn("Failed to release reader lock:", error);
      }
    }
  }

  private async _authThenSend(message: JSONRPCMessage): Promise<void> {
    if (!this._authProvider) {
      throw new UnauthorizedError("No auth provider");
    }

    const result = await auth(this._authProvider, { serverUrl: this._url });
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError();
    }

    await this.send(message);
  }

  start(): Promise<void> {
    // No persistent connection needed
    return Promise.resolve();
  }

  close(): Promise<void> {
    try {
      if (this._abortController) {
        try {
          this._abortController.abort();
        } catch (error) {
          console.warn("Failed to abort controller:", error);
        }
        this._abortController = undefined;
      }

      if (this._eventSource) {
        try {
          this._eventSource.close();
        } catch (error) {
          console.warn("Failed to close EventSource:", error);
        }
        this._eventSource = undefined;
      }

      this.onclose?.();
    } catch (error) {
      this.onerror?.(new Error(`Error during close: ${error}`));
    }
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Create a new abort controller for this request
    this._abortController = new AbortController();
    let response: Response | undefined;

    try {
      const commonHeaders = await this._commonHeaders();
      const headers = new Headers({
        ...commonHeaders,
        ...this._requestInit?.headers,
      });
      headers.set("content-type", "application/json");

      const init = {
        ...this._requestInit,
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: this._abortController.signal,
      };

      response = await fetch(this._url, init);

      if (!response.ok) {
        if (response.status === 401 && this._authProvider) {
          await this._authThenSend(message);
          return;
        }

        const text = await response.text().catch((error) =>
          `Failed to read error response: ${error}`
        );
        throw new Error(
          `Error POSTing to endpoint (HTTP ${response.status}): ${text}`,
        );
      }

      // Handle streaming responses
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("text/event-stream")) {
        // Don't await streaming response handling - it will continue in the background
        this._handleStreamingResponse(response);
        return;
      }

      // Handle immediate JSON responses
      try {
        const responseData = await response.json();
        const responseMessage = JSONRPCMessageSchema.parse(responseData);
        this.onmessage?.(responseMessage);
      } catch (error) {
        throw new Error(`Failed to parse response: ${error}`);
      }
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    } finally {
      // Only clean up the abort controller for non-streaming responses
      if (
        !response?.headers.get("content-type")?.includes("text/event-stream")
      ) {
        this._abortController = undefined;
      }
    }
  }

  /**
   * Call this method after the user has finished authorizing via their user agent and is redirected back to the MCP client application.
   */
  async finishAuth(authorizationCode: string): Promise<void> {
    if (!this._authProvider) {
      throw new UnauthorizedError("No auth provider");
    }

    const result = await auth(this._authProvider, {
      serverUrl: this._url,
      authorizationCode,
    });
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize");
    }
  }
}
