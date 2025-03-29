import {
  type AppManifest,
  context,
  type Deco,
  type JSONSchema7,
  type Schemas,
} from "@deco/deco";
import type { Context, MiddlewareHandler, Next } from "@hono/hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "./sse.ts";
import { HttpServerTransport } from "./http.ts";
import { dereferenceSchema } from "./utils.ts";
import { WebSocketServerTransport } from "./websocket.ts";
import { compose, type RequestMiddleware } from "./middleware.ts";
import type { z } from "zod";
const idFromDefinition = (definition: string) => {
  const [_, __, id] = definition.split("/");
  return id;
};

const IS_DEBUG = Deno.env.get("DEBUG") === "1";
const RESOLVABLE_DEFINITION = "#/definitions/Resolvable";

function setupMcpServer<TManifest extends AppManifest>(
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
) {
  const mcp = new McpServer({
    name: `deco-site-${crypto.randomUUID()}`,
    version: context.deploymentId ?? "unknown",
  }, {
    capabilities: {
      tools: {},
    },
  });

  registerTools(mcp, deco, options);

  // Store active SSE connections
  const transports = new Map<string, SSEServerTransport>();

  return { mcp, transports };
}

export interface Options<TManifest extends AppManifest> {
  include?: Array<keyof (TManifest["actions"] & TManifest["loaders"])>;
  exclude?: Array<keyof (TManifest["actions"] & TManifest["loaders"])>;
  blocks?: Array<keyof TManifest>;
  basePath?: string;
  middlewares?: {
    listTools?: ListToolsMiddleware[];
    callTool?: CallToolMiddleware[];
  };
}

interface RootSchema extends JSONSchema7 {
  inputSchema?: string;
  outputSchema?: string;
}

// Add slugify helper function
const slugify = (name: string) => {
  return name.replace(/[./]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
};
export interface Tool {
  name: string;
  resolveType: string;
  description: string;
  outputSchema: JSONSchema7;
  inputSchema: JSONSchema7;
}

export const getTools = <TManifest extends AppManifest>(
  toolNames: Map<string, string>,
  schemas?: Schemas,
  options?: Options<TManifest>,
): Tool[] => {
  if (!schemas) return [];

  const blocks = options?.blocks ?? ["loaders", "actions"];

  // Get available functions from all specified blocks
  const availableFunctions = blocks.flatMap((block) => {
    const blockSchema = schemas?.root[block as keyof typeof schemas["root"]] ??
      { anyOf: [] };
    return "anyOf" in blockSchema ? blockSchema.anyOf ?? [] : [];
  });

  const tools = availableFunctions.map(
    (func) => {
      func = func as RootSchema;
      if (!func.$ref || func.$ref === RESOLVABLE_DEFINITION) return;
      const funcDefinition = schemas.definitions[idFromDefinition(func.$ref)];
      const resolveType =
        (funcDefinition.properties?.__resolveType as { default: string })
          .default;

      if (
        options?.include &&
        !options.include.includes(
          resolveType as typeof options.include[number],
        )
      ) return;

      if (
        options?.exclude &&
        options.exclude.includes(
          resolveType as typeof options.exclude[number],
        )
      ) return;

      const getInputSchemaId = () => {
        if ("inputSchema" in func) {
          return func.inputSchema as string;
        }
        const props = funcDefinition.allOf ?? [];
        const propsSchema = props[0];
        const ref = (propsSchema as JSONSchema7)?.$ref;
        return ref;
      };

      const ref = getInputSchemaId();
      const rawInputSchema = ref
        ? schemas.definitions[idFromDefinition(ref)]
        : undefined;

      // Dereference the input schema
      const inputSchema = rawInputSchema
        ? dereferenceSchema(
          rawInputSchema as JSONSchema7,
          schemas.definitions,
        )
        : undefined;

      const outputSchemaId = "outputSchema" in func
        ? func.outputSchema as string
        : undefined;

      const rawOutputSchema = outputSchemaId
        ? schemas.definitions[idFromDefinition(outputSchemaId)]
        : undefined;

      const selfReference = (rawOutputSchema?.anyOf ?? [])[0];

      const outputSchema = selfReference
        ? dereferenceSchema(
          selfReference as JSONSchema7,
          schemas.definitions,
        )
        : undefined;

      // Handle tool name slugification and clashes
      let toolName = (funcDefinition as { name?: string })?.name ??
        (inputSchema as { name?: string })?.name ?? slugify(resolveType);
      let idx = 1;

      while (
        toolNames.has(toolName) && toolNames.get(toolName) !== resolveType
      ) {
        toolName = `${toolName}-${idx}`;
        idx++;
      }
      toolNames.set(toolName, resolveType);

      const normalizeSchema = (schema?: JSONSchema7): JSONSchema7 => {
        return schema && "type" in schema && schema.type === "object"
          ? schema
          : {
            type: "object",
            additionalProperties: true,
          };
      };
      return {
        name: toolName,
        resolveType,
        description: funcDefinition.description ?? inputSchema?.description ??
          resolveType,
        outputSchema: normalizeSchema(outputSchema),
        inputSchema: normalizeSchema(inputSchema),
      };
    },
  );

  return tools.filter((tool) => tool !== undefined);
};

export interface ListToolsResult {
  tools: Tool[];
}

export type ListToolsMiddleware = RequestMiddleware<
  z.infer<typeof ListToolsRequestSchema>,
  ListToolsResult
>;

export type CallToolMiddleware = RequestMiddleware<
  z.infer<typeof CallToolRequestSchema>,
  { content: { type: "text"; text: string }[] }
>;

function registerTools<TManifest extends AppManifest>(
  mcp: McpServer,
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
) {
  // Add map to store slugified names to original names
  let toolNames: null | Map<string, string> = null;
  const loadTools: ListToolsMiddleware = async (): Promise<ListToolsResult> => {
    toolNames ??= new Map<string, string>();
    const meta = await deco.meta().then((v) => v?.value);
    if (!meta) return { tools: [] };
    const schemas = meta.schema;
    return { tools: getTools(toolNames, schemas, options) };
  };

  const listTools: ListToolsMiddleware = compose(
    ...(options?.middlewares?.listTools ?? []),
    loadTools,
  );

  mcp.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await listTools(request);
  });

  const invokeTool = async (req: z.infer<typeof CallToolRequestSchema>) => {
    IS_DEBUG && console.log(req);
    try {
      const state = await deco.prepareState({
        req: {
          raw: new Request("http://localhost:8000"),
          param: () => ({}),
        },
      });
      // Use the original name from the map when invoking
      if (!toolNames) {
        await loadTools({ request: {} });
      }
      const originalName = toolNames!.get(req.params.name);
      if (!originalName) {
        throw new Error(`Tool not found: ${req.params.name}`);
      }
      const result = await deco.invoke(
        originalName as `#${string}`,
        // deno-lint-ignore no-explicit-any
        req.params.arguments ?? {} as any,
        undefined,
        state,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  const callToolMiddleware: CallToolMiddleware = compose(
    ...(options?.middlewares?.callTool ?? []),
    invokeTool,
  );

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await callToolMiddleware(req);
  });
}

const MESSAGES_ENDPOINT = "/mcp/messages";
export function mcpServer<TManifest extends AppManifest>(
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
): MiddlewareHandler {
  const { mcp, transports } = setupMcpServer(deco, options);

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const basePath = options?.basePath ?? "";

    // Handle WebSocket upgrade if requested
    if (
      path === `${basePath}/mcp/ws` &&
      c.req.raw.headers.get("upgrade") === "websocket"
    ) {
      const { response, socket } = Deno.upgradeWebSocket(c.req.raw);
      const transport = new WebSocketServerTransport();
      transport.acceptWebSocket(socket);
      mcp.server.connect(transport);
      return response;
    }

    // Legacy SSE endpoint for backwards compatibility
    if (path === `${basePath}/mcp/sse`) {
      const transport = new SSEServerTransport(
        `${basePath}${MESSAGES_ENDPOINT}`,
      );
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      const response = transport.createSSEResponse();
      mcp.server.connect(transport);
      return response;
    }

    // Main message endpoint - handles both stateless requests and SSE upgrades
    if (path === `${options?.basePath ?? ""}${MESSAGES_ENDPOINT}`) {
      const sessionId = c.req.query("sessionId");
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          return c.json({ error: "Invalid session" }, 404);
        }

        return await transport.handlePostMessage(c.req.raw);
      }
      // For stateless transport
      const transport = new HttpServerTransport();
      mcp.server.connect(transport);
      const response = await transport.handleMessage(c.req.raw);
      transport.close(); // Close the transport after handling the message
      return response;
    }
    await next();
  };
}
