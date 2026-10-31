import type { Pool } from "pg";
import { DomainError } from "./core.js";
import { encryptSecret, decryptSecret } from "./secrets.js";
import type { AssistantResult } from "./assistant-contract.js";

export interface AssistantSettings {
  enabled: boolean;
  provider: "openai" | "compatible";
  hasKey: boolean;
  monthlyBudgetUsd: number;
  dailyUserLimit: number;
  updatedAt: string;
}
export interface AssistantSettingsInput {
  enabled: boolean;
  provider: "openai" | "compatible";
  monthlyBudgetUsd: number;
  dailyUserLimit: number;
  apiKey?: string;
  clearKey?: boolean;
}
export interface StoredAssistantSettings extends AssistantSettings {
  encryptedCredentials: unknown;
}
const monthStart =
  "date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'";
const dayStart =
  "date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'";

export class AssistantStore {
  constructor(private readonly pool: Pool) {}
  private map(row: any): StoredAssistantSettings {
    return {
      enabled: row?.enabled ?? false,
      provider: row?.provider ?? "openai",
      hasKey: Boolean(row?.encrypted_credentials?.ciphertext),
      monthlyBudgetUsd: Number(row?.monthly_budget_micros ?? 5_000_000) / 1e6,
      dailyUserLimit: row?.daily_user_limit ?? 100,
      updatedAt: row ? new Date(row.updated_at).toISOString() : "",
      encryptedCredentials: row?.encrypted_credentials ?? {},
    };
  }
  async settings(workspace: string) {
    const result = await this.pool.query(
      "select * from assistant_settings where workspace_id=$1",
      [workspace],
    );
    return this.map(result.rows[0]);
  }
  async save(workspace: string, user: string, input: AssistantSettingsInput) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('assistant:'||$1,0))",
        [workspace],
      );
      const old = await client.query(
        "select * from assistant_settings where workspace_id=$1 for update",
        [workspace],
      );
      const previous = this.map(old.rows[0]);
      let credentials =
        input.clearKey || input.provider !== previous.provider
          ? {}
          : previous.encryptedCredentials;
      if (input.apiKey) credentials = encryptSecret({ apiKey: input.apiKey });
      if (input.enabled && !(credentials as any)?.ciphertext)
        throw new DomainError(
          400,
          "Сначала сохраните API-ключ выбранного провайдера.",
          "assistant_key_required",
        );
      await client.query(
        `insert into assistant_settings(workspace_id,enabled,provider,encrypted_credentials,monthly_budget_micros,daily_user_limit) values($1,$2,$3,$4,$5,$6)
        on conflict(workspace_id) do update set enabled=excluded.enabled,provider=excluded.provider,encrypted_credentials=excluded.encrypted_credentials,monthly_budget_micros=excluded.monthly_budget_micros,daily_user_limit=excluded.daily_user_limit,updated_at=clock_timestamp()`,
        [
          workspace,
          input.enabled,
          input.provider,
          JSON.stringify(credentials),
          Math.round(input.monthlyBudgetUsd * 1e6),
          input.dailyUserLimit,
        ],
      );
      await client.query(
        "insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1::uuid,'USER',$2,'assistant.settings_updated','assistant',$1::text,$3)",
        [
          workspace,
          user,
          JSON.stringify({
            enabled: input.enabled,
            provider: input.provider,
            monthlyBudgetUsd: input.monthlyBudgetUsd,
            dailyUserLimit: input.dailyUserLimit,
            keyChanged: Boolean(input.apiKey || input.clearKey),
          }),
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async usage(workspace: string, user: string) {
    const result = await this.pool.query(
      `select coalesce(sum(cost_micros) filter(where created_at>=(${monthStart})),0)::text spent,count(*) filter(where user_id=$2 and created_at>=(${dayStart}))::int today from assistant_requests where workspace_id=$1 and created_at>=least((${monthStart}),(${dayStart}))`,
      [workspace, user],
    );
    return {
      monthSpentUsd: Number(result.rows[0].spent) / 1e6,
      userRequestsToday: Number(result.rows[0].today),
    };
  }
  async reserve(
    workspace: string,
    user: string,
    id: string,
    hash: string,
    model: string,
    settings: StoredAssistantSettings,
    cost: number,
  ): Promise<AssistantResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('assistant:'||$1,0))",
        [workspace],
      );
      const current = this.map(
        (
          await client.query(
            "select * from assistant_settings where workspace_id=$1 for update",
            [workspace],
          )
        ).rows[0],
      );
      if (
        !current.enabled ||
        current.updatedAt !== settings.updatedAt ||
        JSON.stringify(current.encryptedCredentials) !==
          JSON.stringify(settings.encryptedCredentials) ||
        current.provider !== settings.provider ||
        current.monthlyBudgetUsd !== settings.monthlyBudgetUsd ||
        current.dailyUserLimit !== settings.dailyUserLimit
      )
        throw new DomainError(
          409,
          "Настройки помощника изменились. Повторите запрос после проверки настроек.",
          "assistant_settings_changed",
        );
      const old = (
        await client.query(
          "select * from assistant_requests where workspace_id=$1 and request_id=$2",
          [workspace, id],
        )
      ).rows[0];
      if (old) {
        if (old.user_id !== user || old.input_hash !== hash)
          throw new DomainError(
            409,
            "Этот идентификатор уже использован другим запросом.",
            "assistant_request_conflict",
          );
        if (old.status === "succeeded") {
          await client.query("commit");
          return decryptSecret(
            old.encrypted_result,
          ) as unknown as AssistantResult;
        }
        throw new DomainError(
          409,
          old.status === "pending"
            ? "Этот запрос уже обрабатывается."
            : "Запрос уже завершился ошибкой. Для повторной попытки отправьте новое сообщение.",
          "assistant_request_exists",
        );
      }
      await client.query(
        "update assistant_requests set status='failed' where workspace_id=$1 and status='pending' and created_at<now()-interval '2 minutes'",
        [workspace],
      );
      const limits = (
        await client.query(
          `select coalesce(sum(cost_micros) filter(where created_at>=(${monthStart})),0)::text spent,count(*) filter(where user_id=$2 and created_at>=(${dayStart}))::int today,count(*) filter(where status='pending')::int active,count(*) filter(where status='pending' and user_id=$2)::int user_active from assistant_requests where workspace_id=$1 and (created_at>=least((${monthStart}),(${dayStart})) or status='pending')`,
          [workspace, user],
        )
      ).rows[0];
      if (
        Number(limits.spent) + cost >
        Math.round(current.monthlyBudgetUsd * 1e6)
      )
        throw new DomainError(
          402,
          "Месячный бюджет помощника исчерпан. CRM и боты продолжают работать.",
          "assistant_budget_exceeded",
        );
      if (limits.today >= current.dailyUserLimit)
        throw new DomainError(
          402,
          "На сегодня исчерпан ваш лимит запросов к помощнику.",
          "assistant_daily_limit",
        );
      if (limits.active >= 2 || limits.user_active >= 1)
        throw new DomainError(
          409,
          "Дождитесь завершения предыдущего запроса.",
          "assistant_busy",
        );
      await client.query(
        "insert into assistant_requests(workspace_id,request_id,user_id,input_hash,provider,model,status,cost_micros) values($1,$2,$3,$4,$5,$6,'pending',$7)",
        [workspace, id, user, hash, settings.provider, model, cost],
      );
      await client.query(
        "delete from assistant_requests where workspace_id=$1 and created_at<now()-interval '90 days'",
        [workspace],
      );
      await client.query("commit");
      return undefined;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async finish(
    workspace: string,
    id: string,
    result: AssistantResult,
    cost: number,
  ) {
    await this.pool.query(
      "update assistant_requests set status='succeeded',cost_micros=$3,input_tokens=$4,output_tokens=$5,encrypted_result=$6 where workspace_id=$1 and request_id=$2 and status='pending'",
      [
        workspace,
        id,
        cost,
        result.usage.inputTokens,
        result.usage.outputTokens,
        JSON.stringify(
          encryptSecret(result as unknown as Record<string, unknown>),
        ),
      ],
    );
  }
  async fail(workspace: string, id: string) {
    // Retain the upper-bound reservation: a timeout does not prove the provider didn't bill it.
    await this.pool.query(
      "update assistant_requests set status='failed' where workspace_id=$1 and request_id=$2 and status='pending'",
      [workspace, id],
    );
  }
}
