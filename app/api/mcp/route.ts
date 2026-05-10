import { handleStatelessMcpRequest } from "@/lib/mcp/sessions";
import { requireMcpServerAuth } from "@/lib/mcp/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Last-Event-ID",
  "Mcp-Protocol-Version",
  "Mcp-Session-Id"
].join(", ");

const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

export async function OPTIONS() {
  return withCors(new Response(null, { status: 204 }));
}

export async function GET(req: Request) {
  return handleMcpRequest(req);
}

export async function POST(req: Request) {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleMcpRequest(req);
}

async function handleMcpRequest(req: Request) {
  const auth = requireMcpServerAuth(req);
  if (!auth.ok) {
    return withCors(jsonError(auth.status, auth.error));
  }

  try {
    const response = await handleStatelessMcpRequest(req);
    return withCors(response);
  } catch (error) {
    return withCors(jsonError(500, error instanceof Error ? error.message : "unexpected MCP error"));
  }
}

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonError(status: number, message: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message
      },
      id: null
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
