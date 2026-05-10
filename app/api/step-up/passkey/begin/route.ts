import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { RP_ID } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { getUserByUsername } from "@/lib/auth/store";
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

  const user = await getUserByUsername(session.username);
  if (!user || user.credentials.length === 0) {
    return NextResponse.json({ error: "no passkey registered for this user" }, { status: 404 });
  }

  try {
    const pending = await kernelRuntime.getPendingStepUp(body.challengeId);
    if (!pending) {
      return NextResponse.json({ error: "unknown step-up challenge" }, { status: 404 });
    }

    const canBeginInApp =
      pending.channel === "passkey" ||
      (pending.channel === "voice_biometric_callback" && pending.status === "phone_confirmed");

    if (!canBeginInApp) {
      return NextResponse.json(
        { error: "voice confirmation is still required before app verification can begin" },
        { status: 400 }
      );
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: user.credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports
      })),
      userVerification: "preferred"
    });

    await kernelRuntime.beginPasskeyStepUp(body.challengeId, user.username, options.challenge);
    return NextResponse.json(options);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    );
  }
}
