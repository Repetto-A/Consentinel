import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPlatanusMcpServer } from "@/src/mcp/createServer";

// Stateless handler: a fresh server + transport are created per request and
// torn down once the response is produced. There is no in-memory session map,
// so the handler is safe across Lambda cold starts on Vercel.
export async function handleStatelessMcpRequest(req: Request): Promise<Response> {
  const server = createPlatanusMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

// Kept for tests that previously cleared session state. In stateless mode
// there is nothing to reset, but the symbol stays so existing imports compile.
export async function resetMcpSessions(): Promise<void> {
  // no-op
}
