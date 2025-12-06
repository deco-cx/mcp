import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";

export class HttpServerTransport extends StreamableHTTPServerTransport {
  constructor(
    options?:
      & Omit<StreamableHTTPServerTransportOptions, "sessionIdGenerator">
      & {
        sessionIdGenerator?: () => string;
      },
  ) {
    super({
      ...options,
      sessionIdGenerator: options?.sessionIdGenerator,
    });
  }

  async handleMessage(req: Request): Promise<Response> {
    const { req: nodeReq, res } = toReqRes(req);
    super.handleRequest(nodeReq, res, req.method === "GET" ? null : await req.json().catch(() => null));
    return toFetchResponse(res);
  }
}
