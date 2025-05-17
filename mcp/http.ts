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
      sessionIdGenerator: options?.sessionIdGenerator ??
        (() => crypto.randomUUID()),
    });
  }

  async handleMessage(req: Request) {
    const { req: nodeReq, res } = toReqRes(req);
    await super.handleRequest(nodeReq, res, await req.json());
    return toFetchResponse(res);
  }
}
