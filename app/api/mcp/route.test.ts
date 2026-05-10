import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { demoProfile, seedEvents } from "@/src/demoFixtures.js";
import { FileDurableEventRepository, FilePendingStepUpRepository } from "@/src/runtime/repositories.js";
import { KernelRuntime } from "@/src/runtime/runtime.js";
import { ensureWalletTestEnv } from "@/src/testEnv.js";
import { POST } from "./route";
import { resetMcpSessions } from "@/lib/mcp/sessions";

ensureWalletTestEnv();
process.env.MCP_SERVER_TOKEN = "test-mcp-token";

function makeRuntime(tempDir: string) {
  return new KernelRuntime({
    profile: demoProfile,
    seedTrackEvents: seedEvents,
    durableEvents: new FileDurableEventRepository(join(tempDir, "durable-events.jsonl")),
    pendingStepUps: new FilePendingStepUpRepository(join(tempDir, "pending-stepups.json")),
    clock: () => new Date("2026-05-09T12:00:00.000Z")
  });
}

test("remote MCP route handles initialize and tools/list statelessly", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-route-"));
  globalThis.__consentinelRuntime = makeRuntime(tempDir);
  await resetMcpSessions();

  const initializeResponse = await POST(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-mcp-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "route-test-client",
            version: "0.1.0"
          }
        }
      })
    })
  );

  assert.equal(initializeResponse.status, 200);
  // Stateless mode: server must NOT issue a session ID.
  assert.equal(initializeResponse.headers.get("mcp-session-id"), null);

  const initializeBody = await initializeResponse.json();
  assert.equal(initializeBody.result.serverInfo.name, "platanus-agent-permission-kernel");

  const listToolsResponse = await POST(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-mcp-token",
        "content-type": "application/json",
        "mcp-protocol-version": DEFAULT_NEGOTIATED_PROTOCOL_VERSION
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      })
    })
  );

  assert.equal(listToolsResponse.status, 200);
  const listToolsBody = await listToolsResponse.json();
  assert.ok(
    listToolsBody.result.tools.some((tool: { name: string }) => tool.name === "platanus_get_step_up_challenge")
  );
  assert.ok(
    listToolsBody.result.tools.some((tool: { name: string }) => tool.name === "platanus_confirm_phone_step_up")
  );

  globalThis.__consentinelRuntime = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});
