import { NextResponse } from "next/server";
import { getSharedKernelRuntime } from "@/src/runtime/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel — multilingual default
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

const kernelRuntime = getSharedKernelRuntime();

// Public on purpose: the challengeId is an unguessable UUID and the audio
// merely re-states the action phrase that Kapso already has via
// /api/step-up/voice/:challengeId. Public access lets Kapso "Send Audio"
// fetch the URL without needing custom headers.
export async function GET(_req: Request, context: { params: { challengeId: string } }) {
  const challengeId = context.params.challengeId;
  const pending = await kernelRuntime.getPendingStepUp(challengeId);
  if (!pending) {
    return NextResponse.json({ error: "unknown challenge" }, { status: 404 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 500 });
  }
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;

  const userName = pending.userDisplayName ?? pending.verificationUsername ?? "che";
  const text = `Hola ${userName}. Soy el verificador de Consentinel. Tu agente quiere ${pending.actionPhrase}. Te mande un WhatsApp con el link para autorizar con passkey. Si no fuiste vos, ignoralo.`;

  const elevenRes = await fetch(`${ELEVENLABS_TTS_URL}/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });

  if (!elevenRes.ok) {
    const errorText = await elevenRes.text();
    return NextResponse.json(
      { error: "elevenlabs_tts_failed", status: elevenRes.status, detail: errorText },
      { status: 502 }
    );
  }

  const audio = await elevenRes.arrayBuffer();
  return new Response(audio, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.byteLength),
      "Cache-Control": "private, max-age=300"
    }
  });
}
