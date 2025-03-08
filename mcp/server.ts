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

const idFromDefinition = (definition: string) => {
  const [_, __, id] = definition.split("/");
  return id;
};

const RESOLVABLE_DEFINITION = "#/definitions/Resolvable";

function setupMcpServer<TManifest extends AppManifest>(
  deco: Deco<TManifest>,
) {
  const mcp = new McpServer({
    name: `deco-site-${context.site ?? Deno.env.get("DECO_SITE_NAME")}`,
    version: context.deploymentId ?? "unknown",
  }, {
    capabilities: {
      tools: {},
    },
  });

  registerTools(mcp, deco);

  // Store active SSE connections
  const transports = new Map<string, SSEServerTransport>();

  return { mcp, transports };
}

function registerTools<TManifest extends AppManifest>(
  mcp: McpServer,
  deco: Deco<TManifest>,
) {
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

        return {
          name: resolveType,
          description: funcDefinition.description ?? inputSchema?.description,
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
    try {
      const state = await deco.prepareState({
        req: {
          raw: new Request("http://localhost:8000"),
          param: () => ({}),
        },
      });
      const result = await deco.invoke(
        req.params.name,
        req.params.arguments,
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
): MiddlewareHandler {
  const { mcp, transports } = setupMcpServer(deco);

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;

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
