import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { RP_ID, getExpectedOrigin } from "@/lib/auth/config";
import {
  consumeChallenge,
  findCredentialById,
  getUserByUsername,
  updateCredentialCounter,
} from "@/lib/auth/store";
import { getSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    username?: string;
    response?: AuthenticationResponseJSON;
  };

  if (!body.username || !body.response) {
    return NextResponse.json(
      { error: "username and response required" },
      { status: 400 }
    );
  }

  const user = await getUserByUsername(body.username);
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }

  const expectedChallenge = await consumeChallenge(body.username);
  if (!expectedChallenge) {
    return NextResponse.json(
      { error: "no pending challenge" },
      { status: 400 }
    );
  }

  const credential = await findCredentialById(user.username, body.response.id);
  if (!credential) {
    return NextResponse.json(
      { error: "unknown credential" },
      { status: 404 }
    );
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req.headers.get("origin")),
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: credential.id,
        credentialPublicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  if (!verification.verified) {
    return NextResponse.json({ error: "verification failed" }, { status: 400 });
  }

  await updateCredentialCounter(
    user.username,
    credential.id,
    verification.authenticationInfo.newCounter
  );

  const session = await getSession();
  session.userId = user.id;
  session.username = user.username;
  await session.save();

  return NextResponse.json({ verified: true });
}
