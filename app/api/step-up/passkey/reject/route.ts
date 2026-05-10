import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { viewerOwnsStepUp } from "@/lib/step-up/viewer-auth";
import { getSharedKernelRuntime } from "@/src/runtime/runtime";

export const runtime = "nodejs";

const kernelRuntime = getSharedKernelRuntime();

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    challengeId?: string;
  };

  if (!body.challengeId) {
    return NextResponse.json({ error: "challengeId required" }, { status: 400 });
  }

  const session = await getSession();
  if (!session.username) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }

  const pending = await kernelRuntime.getPendingStepUp(body.challengeId);
  if (!pending) {
    return NextResponse.json({ error: "unknown challenge" }, { status: 404 });
  }

  if (!viewerOwnsStepUp(pending, session.username)) {
    return NextResponse.json(
      { error: "this challenge belongs to another user" },
      { status: 403 }
    );
  }

  try {
    const result = await kernelRuntime.rejectStepUp(body.challengeId, "user_denied");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    );
  }
}
