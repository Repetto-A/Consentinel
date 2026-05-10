import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { RP_ID } from "@/lib/auth/config";
import { getUserByUsername, setChallenge } from "@/lib/auth/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { username } = (await req.json().catch(() => ({}))) as {
    username?: string;
  };

  if (!username || typeof username !== "string" || !username.trim()) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  const user = await getUserByUsername(username);
  if (!user || user.credentials.length === 0) {
    return NextResponse.json(
      { error: "no passkey registered for this user" },
      { status: 404 }
    );
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: user.credentials.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    userVerification: "preferred",
  });

  await setChallenge(user.username, options.challenge);

  return NextResponse.json(options);
}
