import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DurableRuntimeEvent, PendingStepUp } from "./types";
import { normalizeHandoffCode } from "../stepup/presentation";
import { getUpstashClient, isUpstashConfigured } from "../../lib/persist/upstash";

const PENDING_STEPUPS_KEY = "consentinel:runtime:pending-stepups";
const DURABLE_EVENTS_KEY = "consentinel:runtime:durable-events";

function runtimeDataPath(...segments: string[]) {
  if (process.env.VERCEL || process.env.NOW_REGION) {
    return resolve("/tmp", "data", "runtime", ...segments);
  }
  return resolve(process.cwd(), "data", "runtime", ...segments);
}

interface PendingStepUpFile {
  version: 1;
  items: PendingStepUp[];
}

const EMPTY_PENDING_FILE: PendingStepUpFile = {
  version: 1,
  items: []
};

export interface DurableEventRepository {
  list(): Promise<DurableRuntimeEvent[]>;
  append(event: DurableRuntimeEvent): Promise<void>;
}

export interface PendingStepUpRepository {
  list(): Promise<PendingStepUp[]>;
  get(challengeId: string): Promise<PendingStepUp | undefined>;
  getByHandoffCode(handoffCode: string): Promise<PendingStepUp | undefined>;
  upsert(stepUp: PendingStepUp): Promise<void>;
}

export class FileDurableEventRepository implements DurableEventRepository {
  constructor(
    private readonly filePath = runtimeDataPath("durable-events.jsonl")
  ) {}

  async list(): Promise<DurableRuntimeEvent[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DurableRuntimeEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async append(event: DurableRuntimeEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }
}

export class FilePendingStepUpRepository implements PendingStepUpRepository {
  constructor(
    private readonly filePath = runtimeDataPath("pending-stepups.json")
  ) {}

  async list(): Promise<PendingStepUp[]> {
    return (await this.load()).items;
  }

  async get(challengeId: string): Promise<PendingStepUp | undefined> {
    const file = await this.load();
    return file.items.find((item) => item.challengeId === challengeId);
  }

  async getByHandoffCode(handoffCode: string): Promise<PendingStepUp | undefined> {
    const file = await this.load();
    const normalized = normalizeHandoffCode(handoffCode);
    return file.items.find((item) => normalizeHandoffCode(item.handoffCode) === normalized);
  }

  async upsert(stepUp: PendingStepUp): Promise<void> {
    const file = await this.load();
    const index = file.items.findIndex((item) => item.challengeId === stepUp.challengeId);
    if (index >= 0) {
      file.items[index] = stepUp;
    } else {
      file.items.push(stepUp);
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
  }

  private async load(): Promise<PendingStepUpFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PendingStepUpFile>;
      return {
        version: 1,
        items: parsed.items ?? []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...EMPTY_PENDING_FILE, items: [] };
      }

      throw error;
    }
  }
}

export class UpstashDurableEventRepository implements DurableEventRepository {
  async list(): Promise<DurableRuntimeEvent[]> {
    const items = await getUpstashClient().lrange(DURABLE_EVENTS_KEY, 0, -1);
    return items as unknown as DurableRuntimeEvent[];
  }

  async append(event: DurableRuntimeEvent): Promise<void> {
    await getUpstashClient().rpush(DURABLE_EVENTS_KEY, event);
  }
}

export class UpstashPendingStepUpRepository implements PendingStepUpRepository {
  async list(): Promise<PendingStepUp[]> {
    const items = await getUpstashClient().hvals(PENDING_STEPUPS_KEY);
    return items as PendingStepUp[];
  }

  async get(challengeId: string): Promise<PendingStepUp | undefined> {
    const value = await getUpstashClient().hget(PENDING_STEPUPS_KEY, challengeId);
    return (value as PendingStepUp | null) ?? undefined;
  }

  async getByHandoffCode(handoffCode: string): Promise<PendingStepUp | undefined> {
    const items = await this.list();
    const normalized = normalizeHandoffCode(handoffCode);
    return items.find((item) => normalizeHandoffCode(item.handoffCode) === normalized);
  }

  async upsert(stepUp: PendingStepUp): Promise<void> {
    await getUpstashClient().hset(PENDING_STEPUPS_KEY, { [stepUp.challengeId]: stepUp });
  }
}

export function defaultDurableEventRepository(): DurableEventRepository {
  return isUpstashConfigured() ? new UpstashDurableEventRepository() : new FileDurableEventRepository();
}

export function defaultPendingStepUpRepository(): PendingStepUpRepository {
  return isUpstashConfigured() ? new UpstashPendingStepUpRepository() : new FilePendingStepUpRepository();
}
