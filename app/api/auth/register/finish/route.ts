import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { RP_ID, getExpectedOrigin } from "@/lib/auth/config";
import {
  addCredential,
  consumeChallenge,
  getUserByUsername,
} from "@/lib/auth/store";
import { getSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    username?: string;
    response?: RegistrationResponseJSON;
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

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req.headers.get("origin")),
      expectedRPID: RP_ID,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "verification failed" }, { status: 400 });
  }

  const {
    credentialID,
    credentialPublicKey,
    counter,
    credentialDeviceType,
    credentialBackedUp,
  } = verification.registrationInfo;

  await addCredential(user.username, {
    id: credentialID,
    publicKey: credentialPublicKey,
    counter,
    transports: body.response.response.transports,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  });

  const session = await getSession();
  session.userId = user.id;
  session.username = user.username;
  await session.save();

  return NextResponse.json({ verified: true });
}
