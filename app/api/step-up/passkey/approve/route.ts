import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { viewerOwnsStepUp } from "@/lib/step-up/viewer-auth";
import { getSharedKernelRuntime } from "@/src/runtime/runtime";

export const runtime = "nodejs";

const kernelRuntime = getSharedKernelRuntime();

// Approve the step-up using just the existing logged-in session.
// Rationale: the user already proved control of the passkey when they
// logged in, the session cookie is httpOnly + signed, and the deeplink
// is bound to the challenge. Asking for a second passkey on the same
// page would be ceremony without extra security.
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
    const resumed = await kernelRuntime.completeVerifiedStepUp(body.challengeId, session.username);
    return NextResponse.json({
      verified: true,
      challengeId: body.challengeId,
      resumed
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    );
  }
}
