import {
  type AppManifest,
  context,
  type Deco,
  type JSONSchema7,
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
function registerTools<TManifest extends AppManifest>(
  mcp: McpServer,
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
) {
  // Add map to store slugified names to original names
  const toolNames = new Map<string, string>();

  // Add slugify helper function
  const slugify = (name: string) => {
    return name.replace(/[./]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
  };

  const getTools = async () => {
    const meta = await deco.meta();
    if (!meta) return [];
    const schemas = meta.value.schema;
    if (!schemas) return [];

    const loaders = schemas?.root.loaders ?? { anyOf: [] };
    const actions = schemas?.root.actions ?? { anyOf: [] };
    const availableLoaders = "anyOf" in loaders ? loaders.anyOf ?? [] : [];
    const availableActions = "anyOf" in actions ? actions.anyOf ?? [] : [];

    const tools = [...availableLoaders, ...availableActions].map(
      (func) => {
        func = func as JSONSchema7;
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

        const props = funcDefinition.allOf ?? [];
        const propsSchema = props[0];
        const ref = (propsSchema as JSONSchema7)?.$ref;
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

        // Handle tool name slugification and clashes
        let toolName = (funcDefinition as { name?: string })?.name ??
          slugify(resolveType);
        let idx = 1;

        while (toolNames.has(toolName)) {
          toolName = `${toolName}-${idx}`;
          idx++;
        }
        toolNames.set(toolName, resolveType);

        return {
          name: toolName,
          description: funcDefinition.description ?? inputSchema?.description ??
            resolveType,
          inputSchema: inputSchema && "type" in inputSchema &&
              inputSchema.type === "object"
            ? inputSchema
            : {
              type: "object",
              properties: {},
            },
        };
      },
    );

    return tools.filter((tool) => tool !== undefined);
  };

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: await getTools() };
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
