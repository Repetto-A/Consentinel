import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { RP_ID, RP_NAME } from "@/lib/auth/config";
import { getOrCreateUser, setChallenge } from "@/lib/auth/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { username } = (await req.json().catch(() => ({}))) as {
    username?: string;
  };

  if (!username || typeof username !== "string" || !username.trim()) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  const user = await getOrCreateUser(username);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    attestationType: "none",
    excludeCredentials: user.credentials.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await setChallenge(user.username, options.challenge);

  return NextResponse.json(options);
}
