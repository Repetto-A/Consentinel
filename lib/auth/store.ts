import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
} from "@simplewebauthn/types";
import { getUpstashClient, isUpstashConfigured } from "@/lib/persist/upstash";

export interface PasskeyCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
}

export interface StoredUser {
  id: string;
  username: string;
  credentials: PasskeyCredential[];
  currentChallenge?: string;
}

interface SerializedCredential
  extends Omit<PasskeyCredential, "publicKey"> {
  publicKeyBase64: string;
}

interface SerializedUser extends Omit<StoredUser, "credentials"> {
  credentials: SerializedCredential[];
}

function key(username: string): string {
  return username.trim().toLowerCase();
}

function userRedisKey(username: string): string {
  return `consentinel:user:${key(username)}`;
}

function serializeUser(user: StoredUser): SerializedUser {
  return {
    id: user.id,
    username: user.username,
    currentChallenge: user.currentChallenge,
    credentials: user.credentials.map((c) => ({
      id: c.id,
      publicKeyBase64: Buffer.from(c.publicKey).toString("base64"),
      counter: c.counter,
      transports: c.transports,
      deviceType: c.deviceType,
      backedUp: c.backedUp,
    })),
  };
}

function deserializeUser(s: SerializedUser): StoredUser {
  return {
    id: s.id,
    username: s.username,
    currentChallenge: s.currentChallenge,
    credentials: s.credentials.map((c) => ({
      id: c.id,
      publicKey: new Uint8Array(Buffer.from(c.publicKeyBase64, "base64")),
      counter: c.counter,
      transports: c.transports,
      deviceType: c.deviceType,
      backedUp: c.backedUp,
    })),
  };
}

interface UserBackend {
  get(username: string): Promise<StoredUser | undefined>;
  set(user: StoredUser): Promise<void>;
}

class UpstashUserBackend implements UserBackend {
  async get(username: string): Promise<StoredUser | undefined> {
    const raw = await getUpstashClient().get<SerializedUser>(userRedisKey(username));
    if (!raw) return undefined;
    return deserializeUser(raw);
  }

  async set(user: StoredUser): Promise<void> {
    await getUpstashClient().set(userRedisKey(user.username), serializeUser(user));
  }
}

class FileUserBackend implements UserBackend {
  private filePath(): string {
    if (process.env.VERCEL || process.env.NOW_REGION) {
      return resolve("/tmp", "data", "users.json");
    }
    return resolve(process.cwd(), "data", "users.json");
  }

  private load(): Map<string, SerializedUser> {
    try {
      const raw = readFileSync(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as { users?: SerializedUser[] };
      const map = new Map<string, SerializedUser>();
      for (const u of parsed.users ?? []) {
        map.set(key(u.username), u);
      }
      return map;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn("user store load failed", err);
      }
      return new Map();
    }
  }

  private save(map: Map<string, SerializedUser>): void {
    const file = this.filePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ version: 1, users: [...map.values()] }),
      "utf8"
    );
  }

  async get(username: string): Promise<StoredUser | undefined> {
    const found = this.load().get(key(username));
    return found ? deserializeUser(found) : undefined;
  }

  async set(user: StoredUser): Promise<void> {
    const map = this.load();
    map.set(key(user.username), serializeUser(user));
    this.save(map);
  }
}

let cachedBackend: UserBackend | null = null;

function backend(): UserBackend {
  if (!cachedBackend) {
    cachedBackend = isUpstashConfigured() ? new UpstashUserBackend() : new FileUserBackend();
  }
  return cachedBackend;
}

export async function getUserByUsername(username: string): Promise<StoredUser | undefined> {
  return backend().get(username);
}

export async function getOrCreateUser(username: string): Promise<StoredUser> {
  const existing = await backend().get(username);
  if (existing) return existing;
  const created: StoredUser = {
    id: randomUUID(),
    username: username.trim(),
    credentials: [],
  };
  await backend().set(created);
  return created;
}

export async function setChallenge(username: string, challenge: string): Promise<void> {
  const user = await backend().get(username);
  if (!user) return;
  user.currentChallenge = challenge;
  await backend().set(user);
}

export async function consumeChallenge(username: string): Promise<string | undefined> {
  const user = await backend().get(username);
  if (!user) return undefined;
  const challenge = user.currentChallenge;
  user.currentChallenge = undefined;
  await backend().set(user);
  return challenge;
}

export async function addCredential(
  username: string,
  credential: PasskeyCredential
): Promise<void> {
  const user = await backend().get(username);
  if (!user) throw new Error(`unknown user ${username}`);
  user.credentials.push(credential);
  await backend().set(user);
}

export async function findCredentialById(
  username: string,
  credentialId: string
): Promise<PasskeyCredential | undefined> {
  const user = await backend().get(username);
  if (!user) return undefined;
  return user.credentials.find((c) => c.id === credentialId);
}

export async function updateCredentialCounter(
  username: string,
  credentialId: string,
  counter: number
): Promise<void> {
  const user = await backend().get(username);
  if (!user) return;
  const cred = user.credentials.find((c) => c.id === credentialId);
  if (!cred) return;
  cred.counter = counter;
  await backend().set(user);
}
