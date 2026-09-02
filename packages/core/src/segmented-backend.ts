// SPDX-License-Identifier: Apache-2.0
// INIT-048 / STORY-334 + STORY-345: a dependency-free local segmented backend.
// Event records remain one canonical JSON value per NDJSON line. The backend
// owns the segment-local and global sidecars; callers continue to address the
// data plane through StorageBackend.

import { createHash } from "node:crypto";

import { assertCanonicalJson, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import { FileBackend, StorageError, type StorageBackend, type StorageDirectoryEntry, type WorkspaceCrashPoint } from "./storage-backend.js";

export interface SegmentedBackendProfile {
  readonly segmentExtension: string;
  readonly indexExtension: string;
  readonly labelsIndexName: string;
  readonly timeIndexName: string;
  readonly manifestName: string;
}

export const SEGMENTED_BACKEND_PROFILE: SegmentedBackendProfile = Object.freeze({
  segmentExtension: ".ndjson",
  indexExtension: ".idx",
  labelsIndexName: "labels.idx",
  timeIndexName: "time.idx",
  manifestName: "manifest.json",
});

export interface SegmentIndexEntry {
  readonly segment: string;
  readonly offset: number;
  readonly length: number;
}

export interface SegmentIndexDocument {
  readonly schemaVersion: "tcrn.segment-index.v1";
  readonly segment: string;
  readonly entries: Readonly<Record<string, SegmentIndexEntry>>;
}

export interface SegmentManifestEntry {
  readonly name: string;
  readonly bytes: number;
  readonly records: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly sha256: string;
}

export interface SegmentManifest {
  readonly schemaVersion: "tcrn.segment-manifest.v1";
  readonly activeSegment: string | null;
  readonly segments: readonly SegmentManifestEntry[];
  readonly labelsDigest: string;
  readonly timeDigest: string;
}

function storageError(message: string): never {
  throw new StorageError("WORKSPACE_INDEX_INVALID", message);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function segmentNumber(name: string): number {
  const match = /^(\d{6})\.ndjson$/u.exec(name);
  if (match === null) storageError(`invalid segmented event name ${name}`);
  return Number(match[1]);
}

/**
 * A StorageBackend implementation that keeps FileBackend's hardened path and
 * atomic-write semantics while adding NDJSON segments and sidecar indexes.
 */
export class SegmentedBackend implements StorageBackend {
  readonly backendKind = "file-segmented" as const;

  constructor(
    workspaceRoot: string,
    private readonly delegate: FileBackend = new FileBackend(workspaceRoot),
    private readonly profile: SegmentedBackendProfile = SEGMENTED_BACKEND_PROFILE,
  ) {}

  readMetadataBytes(): Promise<Buffer> {
    return this.delegate.readMetadataBytes();
  }

  writeMetadataBytes(content: Buffer, crashAt?: WorkspaceCrashPoint): Promise<void> {
    return this.delegate.writeMetadataBytes(content, crashAt);
  }

  async listSegmentNames(): Promise<string[]> {
    const entries = await this.delegate.listControlEntries("events");
    return entries
      // Sidecars are backend-owned and are not event segments. Every other
      // entry is surfaced so the engine's shape check fails closed on residue.
      .filter((entry) => entry.name !== this.profile.labelsIndexName && entry.name !== this.profile.timeIndexName &&
        entry.name !== this.profile.manifestName && !entry.name.endsWith(this.profile.indexExtension))
      .map((entry) => entry.name)
      .sort(compareCanonicalText);
  }

  async readSegment(name: string): Promise<Buffer> {
    if (!/^\d{6}\.ndjson$/u.test(name)) {
      throw new Error(`WORKSPACE_EVENT_CORRUPT: unexpected segmented event entry ${name}`);
    }
    return this.delegate.readControlFile(`events/${name}`, 67_108_864);
  }

  async writeSegment(name: string, content: Buffer, crashAt?: WorkspaceCrashPoint): Promise<void> {
    if (!/^\d{6}\.ndjson$/u.test(name)) {
      throw new Error(`WORKSPACE_EVENT_CORRUPT: unexpected segmented event entry ${name}`);
    }
    await this.delegate.writeControlFile(`events/${name}`, content, crashAt);
    await this.rebuildIndexes();
  }

  readView(name: string): Promise<Buffer> {
    return this.delegate.readView(name);
  }

  writeView(name: string, content: string, crashAt?: WorkspaceCrashPoint): Promise<void> {
    return this.delegate.writeView(name, content, crashAt);
  }

  listViewNames(): Promise<string[]> {
    return this.delegate.listViewNames();
  }

  readControlFile(relativePath: string, maximumBytes?: number): Promise<Buffer> {
    return this.delegate.readControlFile(relativePath, maximumBytes);
  }

  writeControlFile(relativePath: string, content: Buffer | string, crashAt?: WorkspaceCrashPoint): Promise<void> {
    return this.delegate.writeControlFile(relativePath, content, crashAt);
  }

  createControlDirectory(): Promise<void> {
    return this.delegate.createControlDirectory();
  }

  ensureControlDirectory(relativePath: string): Promise<void> {
    return this.delegate.ensureControlDirectory(relativePath);
  }

  listControlEntries(relativePath: string): Promise<readonly StorageDirectoryEntry[]> {
    return this.delegate.listControlEntries(relativePath);
  }

  removeControlFile(relativePath: string): Promise<void> {
    return this.delegate.removeControlFile(relativePath);
  }

  async lookupKey(key: string): Promise<SegmentIndexEntry | null> {
    const segments = await this.listSegmentNames();
    for (const segment of segments) {
      let document: SegmentIndexDocument;
      try {
      document = assertCanonicalJson((await this.readControlFile(`events/${segment.slice(0, -7)}${this.profile.indexExtension}`)).toString("utf8")) as unknown as SegmentIndexDocument;
      } catch (error) {
        throw new Error(`WORKSPACE_INDEX_INVALID: ${segment}: ${String(error)}`);
      }
      if (!isObject(document) || document.schemaVersion !== "tcrn.segment-index.v1" || document.segment !== segment || !isObject(document.entries)) {
        throw new Error(`WORKSPACE_INDEX_INVALID: ${segment} has an invalid index document`);
      }
      const entry = document.entries[key];
      if (isObject(entry) && typeof entry.segment === "string" && Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.length)) {
        return entry as SegmentIndexEntry;
      }
    }
    return null;
  }

  async readByKey(key: string): Promise<Readonly<Record<string, unknown>> | null> {
    const location = await this.lookupKey(key);
    if (location === null) return null;
    const segment = await this.readSegment(location.segment);
    const line = segment.subarray(location.offset, location.offset + location.length).toString("utf8");
    const value = assertCanonicalJson(line);
    if (!isObject(value)) throw new Error(`WORKSPACE_INDEX_INVALID: ${key} does not point to an object`);
    return value;
  }

  async readManifest(): Promise<SegmentManifest> {
    try {
      return assertCanonicalJson((await this.readControlFile(`events/${this.profile.manifestName}`)).toString("utf8")) as unknown as SegmentManifest;
    } catch (error) {
      throw new Error(`WORKSPACE_INDEX_INVALID: manifest: ${String(error)}`);
    }
  }

  async rebuildIndexes(): Promise<void> {
    const segments = await this.listSegmentNames();
    const labels = new Map<string, Set<string>>();
    const times = new Map<string, Set<string>>();
    const manifest: SegmentManifestEntry[] = [];
    for (const segment of segments) {
      const bytes = await this.readSegment(segment);
      const text = bytes.toString("utf8");
      if (!text.endsWith("\n") || text.endsWith("\n\n")) {
        throw new Error(`WORKSPACE_EVENT_CORRUPT: ${segment} is not canonical NDJSON`);
      }
      const entries: Record<string, SegmentIndexEntry> = {};
      let offset = 0;
      let records = 0;
      let firstSequence = 0;
      let lastSequence = 0;
      for (const line of text.split("\n").slice(0, -1)) {
        const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
        const value = assertCanonicalJson(`${line}\n`);
        if (!isObject(value)) {
          throw new Error(`WORKSPACE_EVENT_CORRUPT: ${segment} contains an invalid event`);
        }
        const id = value.id;
        const eventHash = value.eventHash;
        const sequence = value.sequence;
        const occurredAt = value.occurredAt;
        if (typeof id !== "string" || typeof eventHash !== "string" || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || typeof occurredAt !== "string") {
          throw new Error(`WORKSPACE_EVENT_CORRUPT: ${segment} contains an invalid event`);
        }
        const location = { segment, offset, length: lineBytes };
        entries[id] = location;
        entries[eventHash] = location;
        records += 1;
        firstSequence = firstSequence === 0 ? sequence : Math.min(firstSequence, sequence);
        lastSequence = Math.max(lastSequence, sequence);
        const day = occurredAt.slice(0, 10);
        const daySegments = times.get(day) ?? new Set<string>();
        daySegments.add(segment);
        times.set(day, daySegments);
        const payload = value.payload;
        const record = isObject(payload) && isObject(payload.record) ? payload.record : null;
        const eventLabels = record && Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === "string") : [];
        for (const label of eventLabels) {
          const keys = labels.get(label) ?? new Set<string>();
          keys.add(id);
          labels.set(label, keys);
        }
        offset += lineBytes;
      }
      await this.writeAuxiliary(`${segment.slice(0, -7)}${this.profile.indexExtension}`, {
        schemaVersion: "tcrn.segment-index.v1",
        segment,
        entries,
      });
      manifest.push({ name: segment, bytes: bytes.length, records, firstSequence, lastSequence, sha256: sha256(bytes) });
    }
    const labelsDocument = {
      schemaVersion: "tcrn.segment-labels-index.v1",
      labels: Object.fromEntries([...labels.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([label, keys]) => [label, [...keys].sort(compareCanonicalText)])),
    };
    const timeDocument = {
      schemaVersion: "tcrn.segment-time-index.v1",
      buckets: Object.fromEntries([...times.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([day, names]) => {
        const numbers = [...names].sort(compareCanonicalText).map(segmentNumber);
        return [day, { firstSegment: Math.min(...numbers), lastSegment: Math.max(...numbers) }];
      })),
    };
    await this.writeAuxiliary(this.profile.labelsIndexName, labelsDocument);
    await this.writeAuxiliary(this.profile.timeIndexName, timeDocument);
    await this.writeAuxiliary(this.profile.manifestName, {
      schemaVersion: "tcrn.segment-manifest.v1",
      activeSegment: segments.at(-1) ?? null,
      segments: manifest,
      labelsDigest: sha256(Buffer.from(canonicalJson(labelsDocument), "utf8")),
      timeDigest: sha256(Buffer.from(canonicalJson(timeDocument), "utf8")),
    });
  }

  private async writeAuxiliary(relativePath: string, value: unknown): Promise<void> {
    try {
      await this.delegate.writeControlFile(`events/${relativePath}`, canonicalJson(value));
    } catch (error) {
      throw new Error(`WORKSPACE_INDEX_INVALID: ${relativePath}: ${String(error)}`);
    }
  }
}
