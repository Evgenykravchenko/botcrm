import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";
import { DomainError } from "./core.js";

export interface MediaPreparationProgress {
  attemptId: string;
  stage: "connecting" | "transferring" | "finalizing";
  transferredBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}
export interface StoredMediaProgress extends MediaPreparationProgress { sourcePath: string; updatedAt: string; }

export function validateMediaProgress(input: unknown): MediaPreparationProgress {
  const value = input as Partial<MediaPreparationProgress> | null;
  const invalid = () => new DomainError(400, "Media preparation progress is invalid", "invalid_media_progress");
  if (!value || typeof value !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value.attemptId)) || !["connecting", "transferring", "finalizing"].includes(String(value.stage))) throw invalid();
  if (!Number.isSafeInteger(value.transferredBytes) || value.transferredBytes! < 0) throw invalid();
  if (value.totalBytes !== null && (!Number.isSafeInteger(value.totalBytes) || value.totalBytes! <= 0 || value.transferredBytes! > value.totalBytes!)) throw invalid();
  if (value.bytesPerSecond !== null && (typeof value.bytesPerSecond !== "number" || !Number.isFinite(value.bytesPerSecond) || value.bytesPerSecond < 0)) throw invalid();
  if (value.etaSeconds !== null && (!Number.isSafeInteger(value.etaSeconds) || value.etaSeconds! < 0 || value.etaSeconds! > 604_800)) throw invalid();
  if (value.stage !== "transferring" && value.etaSeconds !== null) throw invalid();
  if (value.etaSeconds !== null && (!value.totalBytes || !value.bytesPerSecond)) throw invalid();
  return { attemptId: String(value.attemptId), stage: value.stage!, transferredBytes: value.transferredBytes!, totalBytes: value.totalBytes!, bytesPerSecond: value.bytesPerSecond!, etaSeconds: value.etaSeconds! };
}

@Injectable()
export class ContentMediaProgressService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2_000, query_timeout: 3_000 });
  }
  async onModuleDestroy() { await this.pool?.end(); }

  async begin(workspaceId: string, botSlug: string, mediaId: number, sourcePath: string, progress: MediaPreparationProgress) {
    if (!this.pool) return;
    await this.pool.query(`insert into content_media_progress(workspace_id,bot_id,media_id,source_path,attempt_id,stage,transferred_bytes,total_bytes,bytes_per_second,eta_seconds)
      select b.workspace_id,b.id,$3,$4,$5,$6,$7,$8,$9,$10 from bots b where b.workspace_id=$1 and b.slug=$2
      on conflict(workspace_id,bot_id,media_id) do update set source_path=excluded.source_path,attempt_id=excluded.attempt_id,stage=excluded.stage,transferred_bytes=excluded.transferred_bytes,total_bytes=excluded.total_bytes,bytes_per_second=excluded.bytes_per_second,eta_seconds=excluded.eta_seconds,updated_at=now()`,
    [workspaceId, botSlug, mediaId, sourcePath, progress.attemptId, progress.stage, progress.transferredBytes, progress.totalBytes, progress.bytesPerSecond, progress.etaSeconds]);
    // Interrupted attempts are diagnostic only; keep this table bounded without a background service.
    await this.pool.query("delete from content_media_progress where updated_at < now() - interval '1 day'");
  }

  async update(workspaceId: string, botSlug: string, mediaId: number, sourcePath: string, progress: MediaPreparationProgress) {
    if (!this.pool) return false;
    const result = await this.pool.query(`update content_media_progress p set stage=$6,transferred_bytes=$7,total_bytes=$8,bytes_per_second=$9,eta_seconds=$10,updated_at=now()
      from bots b where p.bot_id=b.id and p.workspace_id=$1 and b.slug=$2 and p.media_id=$3 and p.source_path=$4 and p.attempt_id=$5
      and p.transferred_bytes <= $7 and (p.stage <> 'finalizing' or $6 = 'finalizing')`,
    [workspaceId, botSlug, mediaId, sourcePath, progress.attemptId, progress.stage, progress.transferredBytes, progress.totalBytes, progress.bytesPerSecond, progress.etaSeconds]);
    return Boolean(result.rowCount);
  }

  async clear(workspaceId: string, botSlug: string, mediaId: number) {
    await this.pool?.query("delete from content_media_progress p using bots b where p.bot_id=b.id and p.workspace_id=$1 and b.slug=$2 and p.media_id=$3", [workspaceId, botSlug, mediaId]);
  }

  async list(workspaceId: string, botSlug: string): Promise<Map<number, StoredMediaProgress>> {
    if (!this.pool) return new Map();
    const result = await this.pool.query("select p.* from content_media_progress p join bots b on b.id=p.bot_id where p.workspace_id=$1 and b.slug=$2 and p.updated_at > now() - interval '1 day'", [workspaceId, botSlug]);
    return new Map(result.rows.map((row) => [Number(row.media_id), { sourcePath: row.source_path, attemptId: row.attempt_id, stage: row.stage, transferredBytes: Number(row.transferred_bytes), totalBytes: row.total_bytes == null ? null : Number(row.total_bytes), bytesPerSecond: row.bytes_per_second == null ? null : Number(row.bytes_per_second), etaSeconds: row.eta_seconds == null ? null : Number(row.eta_seconds), updatedAt: new Date(row.updated_at).toISOString() }]));
  }
}
