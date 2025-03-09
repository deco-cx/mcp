import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Server transport for WebSocket: this will handle bidirectional communication over a WebSocket connection.
 */
export class WebSocketServerTransport implements Transport {
  private _socket?: WebSocket;
  private _connected: boolean = false;
  private _sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor() {
    this._sessionId = crypto.randomUUID();
  }

  /**
   * Accepts a WebSocket connection and sets up message handling
   */
  acceptWebSocket(socket: WebSocket): void {
    if (this._socket) {
      throw new Error(
        "WebSocketServerTransport already has an active connection",
      );
    }

    this._socket = socket;
    this._setupSocketHandlers();
  }

  private _setupSocketHandlers(): void {
    if (!this._socket) return;

    this._socket.onclose = () => {
      this._connected = false;
      this.onclose?.();
    };

    this._socket.onerror = (event) => {
      const error = event instanceof Error
        ? event
        : new Error("WebSocket error");
      this.onerror?.(error);
    };

    this._socket.onmessage = (event: MessageEvent) => {
      try {
        const message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    };
  }

  start(): Promise<void> {
    if (!this._socket) {
      throw new Error("WebSocket connection not established!");
    }

    this._connected = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this._socket?.close();
    this._socket = undefined;
    this._connected = false;
    this.onclose?.();
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (!this._connected || !this._socket) {
      throw new Error("Not connected");
    }

    this._socket.send(JSON.stringify(message));
    return Promise.resolve();
  }

  get sessionId(): string {
    return this._sessionId;
  }
}
