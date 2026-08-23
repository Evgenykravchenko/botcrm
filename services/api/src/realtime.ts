import { Injectable, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Client, Notification } from "pg";
import { Observable, Subject, filter, interval, map, merge, of } from "rxjs";

export interface RealtimeChange {
  workspaceId: string;
  entity: string;
  operation: "insert" | "update" | "delete";
  entityId?: string;
  occurredAt: string;
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private client?: Client;
  private readonly changes = new Subject<RealtimeChange>();

  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: "botcrm-realtime" });
    client.on("notification", (message) => this.onNotification(message));
    client.on("error", (error) => console.error("BotCRM realtime PostgreSQL listener", error));
    await client.connect();
    await client.query("LISTEN botcrm_realtime");
    this.client = client;
    console.log("BotCRM realtime: PostgreSQL LISTEN/SSE");
  }

  async onModuleDestroy() {
    this.changes.complete();
    if (this.client) {
      await this.client.query("UNLISTEN botcrm_realtime").catch(() => undefined);
      await this.client.end().catch(() => undefined);
    }
  }

  stream(workspaceId: string): Observable<MessageEvent> {
    const ready = of<MessageEvent>({ type: "ready", data: { type: "ready", occurredAt: new Date().toISOString() } });
    const changes = this.changes.pipe(
      filter((event) => event.workspaceId === workspaceId),
      map((event): MessageEvent => ({ type: "change", id: `${event.occurredAt}:${event.entity}:${event.entityId ?? ""}`, data: { type: "change", ...event } })),
    );
    const heartbeat = interval(15_000).pipe(
      map((): MessageEvent => ({ type: "heartbeat", data: { type: "heartbeat", occurredAt: new Date().toISOString() } })),
    );
    return merge(ready, changes, heartbeat);
  }

  private onNotification(message: Notification) {
    if (!message.payload) return;
    try {
      const event = JSON.parse(message.payload) as RealtimeChange;
      if (event.workspaceId && event.entity && event.operation && event.occurredAt) this.changes.next(event);
    } catch (error) {
      console.warn("Ignored malformed BotCRM realtime notification", error);
    }
  }
}
