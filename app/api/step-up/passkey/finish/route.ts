import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { RP_ID, getExpectedOrigin } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { findCredentialById, getUserByUsername, updateCredentialCounter } from "@/lib/auth/store";
import { getSharedKernelRuntime } from "@/src/runtime/runtime";

export const runtime = "nodejs";

const kernelRuntime = getSharedKernelRuntime();

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    challengeId?: string;
    response?: AuthenticationResponseJSON;
  };

  if (!body.challengeId || !body.response) {
    return NextResponse.json({ error: "challengeId and response required" }, { status: 400 });
  }

  const session = await getSession();
  if (!session.username) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }

  const user = await getUserByUsername(session.username);
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }

  const pending = await kernelRuntime.getPendingStepUp(body.challengeId);
  if (!pending || (pending.status !== "pending" && pending.status !== "phone_confirmed") || !pending.authChallenge) {
    return NextResponse.json({ error: "no pending step-up challenge" }, { status: 400 });
  }

  const credential = await findCredentialById(user.username, body.response.id);
  if (!credential) {
    return NextResponse.json({ error: "unknown credential" }, { status: 404 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: pending.authChallenge,
      expectedOrigin: getExpectedOrigin(req.headers.get("origin")),
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: credential.id,
        credentialPublicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    );
  }

  if (!verification.verified) {
    return NextResponse.json({ error: "verification failed" }, { status: 400 });
  }

  await updateCredentialCounter(user.username, credential.id, verification.authenticationInfo.newCounter);

  try {
    const resumed = await kernelRuntime.completeVerifiedStepUp(body.challengeId, user.username);
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
