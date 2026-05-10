# Kapso + ElevenLabs Step-Up Agent

El repo de skills de Kapso que pasaste (`.agents/skills/agent-skills-master`) hoy trae skills de WhatsApp, no una skill específica de voz. Lo usé como referencia de integración/orquestación y dejé el contrato del agente telefónico listo en este proyecto para conectarlo por HTTP o por MCP.

## Flujo

1. El kernel crea un challenge `voice_biometric_callback` con resumen hablado dinámico, `handoffCode` y `whatsappVerificationUrl`.
2. Kapso obtiene el challenge por MCP o desde `GET /api/step-up/voice/:challengeId`.
3. Kapso manda un WhatsApp con el link de verificación y el código corto.
4. El agente de ElevenLabs llama al usuario y lee la operación concreta que se quiere validar.
5. Si el usuario confirma verbalmente, ElevenLabs/Kapso llama `POST /api/step-up/voice/confirm`.
6. El kernel deja el challenge en `phone_confirmed`.
7. El usuario abre el link de WhatsApp o entra a `/v/:handoffCode` y termina la validación con passkey.
8. Si el usuario rechaza o reporta coacción, ElevenLabs/Kapso llama `POST /api/step-up/voice/reject` y el permiso queda bloqueado.

## Seguridad

Todos los endpoints de voz requieren:

```http
Authorization: Bearer <STEP_UP_SERVICE_TOKEN>
```

Definí el mismo token en tu backend y en Kapso/ElevenLabs.

## MCP remoto para ElevenLabs

El proyecto ahora expone un MCP remoto compatible con ElevenLabs en:

- `POST/GET/DELETE /api/mcp`

Configuración recomendada en ElevenLabs:

- `Transport`: `HTTP streamable`
- `Server URL`: `https://tu-dominio.com/api/mcp`
- `Secret Token`: `MCP_SERVER_TOKEN`

Si `MCP_SERVER_TOKEN` no está definido, el endpoint cae automáticamente en `STEP_UP_SERVICE_TOKEN`.

Tools relevantes:

- `platanus_get_step_up_challenge`
- `platanus_confirm_phone_step_up`
- `platanus_reject_step_up`

Con esto, ElevenLabs puede conectarse directo al kernel para leer el challenge y mutar el estado de la llamada, sin pasar por `stdio`.

## Endpoints

### 1. Obtener challenge

`GET /api/step-up/voice/:challengeId`

Respuesta:

```json
{
  "challengeId": "voice_123",
  "status": "pending",
  "channel": "voice_biometric_callback",
  "handoffCode": "AB4K-P9Q2",
  "deliveryChannel": "whatsapp",
  "deliveryTarget": "+12015348061",
  "userName": "alba",
  "actionPhrase": "enviar 20 USDC a Juan usando un destino nuevo",
  "spokenOperationSummary": "enviar 20 USDC a Juan",
  "spokenRiskHint": "usando un destino nuevo",
  "whatsappVerificationUrl": "http://localhost:3000/v/AB4K-P9Q2",
  "prompt": "...",
  "appVerification": {
    "ready": false,
    "beginPath": "/api/step-up/passkey/begin",
    "finishPath": "/api/step-up/passkey/finish",
    "verificationUrl": "http://localhost:3000/v/AB4K-P9Q2"
  },
  "callScript": {
    "opening": "Hola Alba. Soy el verificador de Consentinel. Tu agente quiere enviar 20 USDC a Juan usando un destino nuevo. ¿Lo autorizás? Sí o no.",
    "onConfirm": "Perfecto. Te mandamos un WhatsApp con el link para validar con passkey.",
    "onReject": "Entendido, cancelado. Chau."
  }
}
```

### 2. Confirmación verbal

`POST /api/step-up/voice/confirm`

```json
{
  "challengeId": "voice_123",
  "provider": "elevenlabs"
}
```

Respuesta:

```json
{
  "ok": true,
  "status": "phone_confirmed",
  "next": {
    "action": "open_whatsapp_verification_link",
    "message": "Abrí el WhatsApp enviado y terminá la verificación con passkey."
  }
}
```

### 3. Rechazo o coacción

`POST /api/step-up/voice/reject`

```json
{
  "challengeId": "voice_123",
  "reason": "user_denied"
}
```

`reason` puede ser `user_denied` o `duress`.

## MCP disponible

Las mismas tools siguen disponibles en el MCP local por `stdio` y ahora también en el MCP remoto:

- `platanus_get_step_up_challenge`
- `platanus_confirm_phone_step_up`
- `platanus_reject_step_up`

## Prompt sugerido para ElevenLabs

Podés usar este prompt como base del agente:

```text
Sos el verificador telefonico de Consentinel. Tu unica funcion es llamar a una persona para confirmar si quiere autorizar o rechazar una accion que su agente de IA intento ejecutar. Vos no autorizas ni rechazás nada por tu cuenta: solo recoges la intencion y le indicas a la persona que termine en la app.

No sos un chatbot. No das soporte. No conversas.

Variables dinamicas:
- challenge_id
- action_phrase
- user_name
- whatsapp_verification_url
- handoff_code

Tools:
1. user_confirmed(challenge_id)
2. user_rejected(challenge_id, reason: "user_denied" | "duress")

Script:
- Apertura: "Hola {{user_name}}. Soy el verificador de Consentinel. Tu agente quiere {{action_phrase}}. ¿Lo autorizás? Sí o no."
- Si responde sí: llama user_confirmed(challenge_id) y decí "Perfecto. Te mandamos un WhatsApp con el link para validar con passkey."
- Si responde no: llama user_rejected(challenge_id, "user_denied") y decí "Entendido, cancelado. Chau."
- Si detectás coacción: llama user_rejected(challenge_id, "duress") y decí "Recibido. Cancelado."
- Si no hay respuesta clara: repetí una vez. Si sigue ambiguo, no llames tools y mandalo a la app.

Reglas:
- Nunca llames más de una tool por llamada.
- Nunca cambies el texto de action_phrase.
- Nunca completes la autorizacion desde la llamada.
- El objetivo es terminar la llamada en menos de 35 segundos.
```

## Nota de implementación

La llamada telefónica no marca el challenge como `verified`. Solo lo mueve a `phone_confirmed`. La verificación final sigue ocurriendo en la web por medio del link de WhatsApp o `/v/:handoffCode`, usando los endpoints:

- `POST /api/step-up/passkey/begin`
- `POST /api/step-up/passkey/finish`
