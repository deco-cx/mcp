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
import { dereferenceSchema } from "./utils.ts";
import { WebSocketServerTransport } from "./websocket.ts";

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
    name: `deco-site-${context.site ?? Deno.env.get("DECO_SITE_NAME")}`,
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

  const loaders = schemas?.root.loaders ?? { anyOf: [] };
  const actions = schemas?.root.actions ?? { anyOf: [] };
  const availableLoaders = "anyOf" in loaders ? loaders.anyOf ?? [] : [];
  const availableActions = "anyOf" in actions ? actions.anyOf ?? [] : [];

  const tools = [...availableLoaders, ...availableActions].map(
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
function registerTools<TManifest extends AppManifest>(
  mcp: McpServer,
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
) {
  // Add map to store slugified names to original names
  const toolNames = new Map<string, string>();

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const meta = await deco.meta().then((v) => v?.value);
    if (!meta) return { tools: [] };
    const schemas = meta.schema;
    return { tools: getTools(toolNames, schemas, options) };
  });

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    IS_DEBUG && console.log(req);
    try {
      const state = await deco.prepareState({
        req: {
          raw: new Request("http://localhost:8000"),
          param: () => ({}),
        },
      });
      // Use the original name from the map when invoking
      const originalName = toolNames.get(req.params.name);
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
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      console.error(err);
      throw err;
    }
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

    if (
      path === "/mcp/ws" && c.req.raw.headers.get("upgrade") === "websocket"
    ) {
      const { response, socket } = Deno.upgradeWebSocket(c.req.raw);

      const transport = new WebSocketServerTransport();

      transport.acceptWebSocket(socket);
      mcp.server.connect(transport);

      return response;
    }

    if (path === "/mcp/sse") {
      const transport = new SSEServerTransport(MESSAGES_ENDPOINT);
      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };

      const response = transport.createSSEResponse();
      mcp.server.connect(transport);

      return response;
    }

    if (path === MESSAGES_ENDPOINT) {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: "Missing sessionId" }, 400);
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        return c.json({ error: "Invalid session" }, 404);
      }

      return await transport.handlePostMessage(c.req.raw);
    }

    await next();
  };
}
