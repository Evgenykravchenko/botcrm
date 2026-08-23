import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConnectionOptions, Queue } from "bullmq";
import { DomainError } from "./core.js";

export const CAMPAIGN_QUEUE = "campaign-delivery";
export const MESSAGE_QUEUE = "message-delivery";
export const BOT_EVENT_QUEUE = "bot-event-delivery";
export interface CampaignJob { workspaceId?: string; recipientId: string; campaignId: string; contactId: string; connectorId: string; externalUserId: string; channel: string; content: string; buttons?: Array<{ id?: string; text: string; type: "callback" | "url"; value: string; row: number }>; media?: Array<{ objectKey: string; filename: string; mimeType: string }>; }
export interface MessageJob { workspaceId: string; messageId: string; conversationId: string; connectorId: string; externalChatId: string; channel: string; }
export interface BotEventJob { workspaceId: string; outboxId: string; }

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return { host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined, password: url.password || undefined, db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0, ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}

@Injectable()
export class CampaignQueueService implements OnModuleInit, OnModuleDestroy {
  private campaignQueue?: Queue<CampaignJob>;
  private messageQueue?: Queue<MessageJob>;
  private botEventQueue?: Queue<BotEventJob>;
  private error?: string;
  async onModuleInit() {
    if (!process.env.REDIS_URL) return;
    const connection = redisConnection(process.env.REDIS_URL);
    const campaignQueue = new Queue<CampaignJob>(CAMPAIGN_QUEUE, { connection, defaultJobOptions: { attempts: 5, backoff: { type: "channel-aware", delay: 2_000 }, removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 604_800, count: 50_000 } } });
    const messageQueue = new Queue<MessageJob>(MESSAGE_QUEUE, { connection, defaultJobOptions: { attempts: 5, backoff: { type: "channel-aware", delay: 2_000 }, removeOnComplete: { age: 86_400, count: 20_000 }, removeOnFail: { age: 604_800, count: 50_000 } } });
    const botEventQueue = new Queue<BotEventJob>(BOT_EVENT_QUEUE, { connection, defaultJobOptions: { attempts: 8, backoff: { type: "channel-aware", delay: 2_000 }, removeOnComplete: { age: 86_400, count: 20_000 }, removeOnFail: { age: 604_800, count: 50_000 } } });
    try { await Promise.all([campaignQueue.waitUntilReady(), messageQueue.waitUntilReady(), botEventQueue.waitUntilReady()]); this.campaignQueue = campaignQueue; this.messageQueue = messageQueue; this.botEventQueue = botEventQueue; console.log("BotCRM queues: Redis/BullMQ"); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); await Promise.all([campaignQueue.close().catch(() => undefined), messageQueue.close().catch(() => undefined), botEventQueue.close().catch(() => undefined)]); }
  }
  async onModuleDestroy() { await Promise.all([this.campaignQueue?.close(), this.messageQueue?.close(), this.botEventQueue?.close()]); }
  status() { return { status: this.campaignQueue && this.messageQueue && this.botEventQueue ? "ok" : "unavailable", error: this.error }; }
  async enqueue(jobs: CampaignJob[]) {
    if (!this.campaignQueue) throw new DomainError(503, "Campaign queue is unavailable", "queue_unavailable");
    if (!jobs.length) return { queued: 0 };
    const runId = Date.now();
    await this.campaignQueue.addBulk(jobs.map((job, index) => ({ name: `deliver:${job.channel}`, data: job, opts: { jobId: `${job.recipientId}-${runId}-${index}` } })));
    return { queued: jobs.length };
  }
  async enqueueMessage(job: MessageJob) {
    if (!this.messageQueue) throw new DomainError(503, "Message delivery queue is unavailable", "queue_unavailable");
    await this.messageQueue.add(`send:${job.channel}`, job, { jobId: job.messageId });
    return { queued: true };
  }
  async enqueueBotEvent(job: BotEventJob) {
    if (!this.botEventQueue) throw new DomainError(503, "Bot event queue is unavailable", "queue_unavailable");
    await this.botEventQueue.add("deliver:bot-event", job, { jobId: job.outboxId });
    return { queued: true };
  }
}
