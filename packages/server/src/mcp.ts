import { t } from "@pandocs/i18n";
import { VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ANONYMOUS_PRINCIPAL,
  PandocsError,
  pandocsTools,
  PUBLIC_TOOL_NAMES,
  type PandocsServices,
  type PandocsTool,
  type Principal
} from "@pandocs/core";
import { ZodError } from "zod";
import type { Identity } from "./auth/identity.js";
import { errorResponse } from "./api/responses.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Agents may read, discuss and propose. Everything else needs a person, so it is not even listed. */
const AGENT_WRITE_TOOLS = new Set([
  "thread_create",
  "thread_reply",
  "thread_resolve",
  "proposal_create",
  "doc_report",
  "change_set_create",
  "change_set_add_page",
  "change_set_remove_page"
]);
const AGENT_HIDDEN_READ_TOOLS = new Set(["doc_trash", "inbox", "import_get", "doc_templates"]);

export function toolsFor(principal: Principal): readonly PandocsTool[] {
  if (principal.anonymous) return pandocsTools.filter(tool => PUBLIC_TOOL_NAMES.has(tool.name));
  if (principal.kind === "agent")
    return pandocsTools.filter(tool =>
      tool.access === "read" ? !AGENT_HIDDEN_READ_TOOLS.has(tool.name) : AGENT_WRITE_TOOLS.has(tool.name)
    );
  return principal.scopes.includes("write") ? pandocsTools : pandocsTools.filter(tool => tool.access === "read");
}

function safeToolError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof PandocsError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    };
  if (error instanceof ZodError) return { code: "INPUT_INVALID", message: t("The request is not valid") };
  return { code: "SERVICE_UNAVAILABLE", message: t("The document service is temporarily unavailable") };
}

function createServer(services: PandocsServices, principal: Principal): McpServer {
  const server = new McpServer({ name: "pandocs", version: VERSION });
  for (const tool of toolsFor(principal)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.access === "read", destructiveHint: tool.destructive === true }
      },
      async (args: unknown) => {
        try {
          const value = { data: await tool.run(services, principal, args as never) };
          return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) {
          const value = { error: safeToolError(error) };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
            structuredContent: value
          };
        }
      }
    );
  }
  return server;
}

async function serve(services: PandocsServices, principal: Principal, request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return errorResponse(413, "BODY_TOO_LARGE", t("The request body is too large"));
  const server = createServer(services, principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

/**
 * The public spaces of a site, for anyone. An address of its own, because `/mcp` answering without a token would
 * leave clients nothing to start a login from, and the people using them only the public pages.
 */
export const servePublicMcp = (services: PandocsServices, request: Request) =>
  serve(services, ANONYMOUS_PRINCIPAL, request);

/** Stateless: each request gets its own server, so any replica can answer any call. */
export function createMcpHandler(deps: { identity: Identity; services: PandocsServices; siteUrl: string }) {
  // Where a client that has no token yet finds out how to get one: below the site's path, which reaches here wherever it lives.
  const challenge = {
    "WWW-Authenticate": `Bearer resource_metadata="${deps.siteUrl}/.well-known/oauth-protected-resource/mcp"`
  };
  return async (request: Request): Promise<Response> => {
    if (!request.headers.get("authorization")) {
      return new Response(
        JSON.stringify({ version: 1, error: { code: "UNAUTHENTICATED", message: t("An API token is needed") } }),
        { status: 401, headers: { ...challenge, "content-type": "application/json" } }
      );
    }
    const auth = await deps.identity.authenticate(request);
    if (!auth.ok) {
      const refused = errorResponse(auth.status, auth.code, auth.message);
      if (auth.status === 401) refused.headers.set("WWW-Authenticate", challenge["WWW-Authenticate"]);
      return refused;
    }
    if (auth.via === "embed" || auth.via === "share")
      return errorResponse(403, "SESSION_REQUIRED", t("An embed token cannot connect to MCP"));
    return serve(deps.services, auth.principal, request);
  };
}
