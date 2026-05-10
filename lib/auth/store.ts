import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
} from "@simplewebauthn/types";

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

declare global {
  // eslint-disable-next-line no-var
  var __consentinelUserStore: Map<string, StoredUser> | undefined;
  // eslint-disable-next-line no-var
  var __consentinelUserStoreHydrated: boolean | undefined;
}

interface SerializedCredential
  extends Omit<PasskeyCredential, "publicKey"> {
  publicKeyBase64: string;
}

interface SerializedUser extends Omit<StoredUser, "credentials"> {
  credentials: SerializedCredential[];
}

interface StoreFile {
  version: 1;
  users: SerializedUser[];
}

function storePath(): string {
  if (process.env.VERCEL || process.env.NOW_REGION) {
    return resolve("/tmp", "data", "users.json");
  }
  return resolve(process.cwd(), "data", "users.json");
}

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function loadFromDisk(): Map<string, StoredUser> {
  const map = new Map<string, StoredUser>();
  try {
    const raw = readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.users)) return map;
    for (const u of parsed.users) {
      const credentials: PasskeyCredential[] = u.credentials.map((c) => ({
        id: c.id,
        publicKey: Buffer.from(c.publicKeyBase64, "base64"),
        counter: c.counter,
        transports: c.transports,
        deviceType: c.deviceType,
        backedUp: c.backedUp,
      }));
      map.set(key(u.username), {
        id: u.id,
        username: u.username,
        credentials,
        currentChallenge: u.currentChallenge,
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("user store load failed", err);
    }
  }
  return map;
}

function persist(users: Map<string, StoredUser>): void {
  const file = storePath();
  ensureDir(file);
  const serialized: StoreFile = {
    version: 1,
    users: [...users.values()].map((u) => ({
      id: u.id,
      username: u.username,
      currentChallenge: u.currentChallenge,
      credentials: u.credentials.map((c) => ({
        id: c.id,
        publicKeyBase64: Buffer.from(c.publicKey).toString("base64"),
        counter: c.counter,
        transports: c.transports,
        deviceType: c.deviceType,
        backedUp: c.backedUp,
      })),
    })),
  };
  writeFileSync(file, JSON.stringify(serialized), "utf8");
}

function key(username: string): string {
  return username.trim().toLowerCase();
}

function getStore(): Map<string, StoredUser> {
  if (!globalThis.__consentinelUserStore) {
    globalThis.__consentinelUserStore = loadFromDisk();
    globalThis.__consentinelUserStoreHydrated = true;
  } else if (!globalThis.__consentinelUserStoreHydrated) {
    // Existing in-memory map but never hydrated from disk on this boot —
    // merge what's on disk in case other Lambda invocations wrote to it.
    const fromDisk = loadFromDisk();
    for (const [k, v] of fromDisk) {
      if (!globalThis.__consentinelUserStore.has(k)) {
        globalThis.__consentinelUserStore.set(k, v);
      }
    }
    globalThis.__consentinelUserStoreHydrated = true;
  }
  return globalThis.__consentinelUserStore;
}

export function getUserByUsername(username: string): StoredUser | undefined {
  return getStore().get(key(username));
}

export function getOrCreateUser(username: string): StoredUser {
  const store = getStore();
  const existing = store.get(key(username));
  if (existing) return existing;
  const created: StoredUser = {
    id: randomUUID(),
    username: username.trim(),
    credentials: [],
  };
  store.set(key(username), created);
  persist(store);
  return created;
}

export function setChallenge(username: string, challenge: string): void {
  const store = getStore();
  const user = store.get(key(username));
  if (!user) return;
  user.currentChallenge = challenge;
  persist(store);
}

export function consumeChallenge(username: string): string | undefined {
  const store = getStore();
  const user = store.get(key(username));
  if (!user) return undefined;
  const challenge = user.currentChallenge;
  user.currentChallenge = undefined;
  persist(store);
  return challenge;
}

export function addCredential(username: string, credential: PasskeyCredential): void {
  const store = getStore();
  const user = store.get(key(username));
  if (!user) throw new Error(`unknown user ${username}`);
  user.credentials.push(credential);
  persist(store);
}

export function findCredentialById(
  username: string,
  credentialId: string
): PasskeyCredential | undefined {
  const user = getStore().get(key(username));
  if (!user) return undefined;
  return user.credentials.find((c) => c.id === credentialId);
}

export function updateCredentialCounter(
  username: string,
  credentialId: string,
  counter: number
): void {
  const store = getStore();
  const user = store.get(key(username));
  if (!user) return;
  const cred = user.credentials.find((c) => c.id === credentialId);
  if (!cred) return;
  cred.counter = counter;
  persist(store);
}
