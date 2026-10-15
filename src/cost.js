import { DurableObject } from "cloudflare:workers";
import { ymd } from "./utils.js";

export class AIPipeCost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cost (
        email TEXT,
        date TEXT,
        cost NUMBER,
        PRIMARY KEY (email, date)
      );
      CREATE INDEX IF NOT EXISTS idx_cost_email_date ON cost(email, date);
      CREATE TABLE IF NOT EXISTS provider_usage (
        date TEXT NOT NULL,
        email TEXT NOT NULL,
        provider TEXT NOT NULL,
        spend_usd REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, email, provider)
      );
    `);
  }

  /** Record positive-cost metered requests; retain existing per-user budget accounting. */
  async add(email, cost, provider, usage = {}) {
    if (cost <= 0) return;
    const date = ymd(new Date());
    this.ctx.storage.sql.exec(
      "INSERT INTO cost (email, date, cost) VALUES (?, ?, ?) ON CONFLICT(email, date) DO UPDATE SET cost = cost + excluded.cost",
      email, date, cost,
    );
    if (!provider) return;
    const input = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const output = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    this.ctx.storage.sql.exec(`
      INSERT INTO provider_usage (date, email, provider, spend_usd, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, email, provider) DO UPDATE SET
        spend_usd = spend_usd + excluded.spend_usd,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
    `, date, email.toLowerCase(), provider, cost,
      Number.isFinite(input) && input > 0 ? Math.floor(input) : 0,
      Number.isFinite(output) && output > 0 ? Math.floor(output) : 0);
  }

  /** Get cost incurred over the last `days` until `now` */
  async cost(email, days, now) {
    const sql = "SELECT SUM(cost) AS cost FROM cost WHERE email = ? AND date >= ? AND date <= ? ORDER BY date";
    const result = (await this.ctx.storage.sql.exec(sql, email, ...dateRange(days, now))).toArray();
    return result[0]?.cost ?? 0;
  }

  /** Total and daily cost incurred by `email` over the last `days` days until `now` (optional) */
  async usage(email, days, now) {
    const sql = "SELECT date, cost FROM cost WHERE email = ? AND date >= ? AND date <= ? ORDER BY date";
    const usage = (await this.ctx.storage.sql.exec(sql, email, ...dateRange(days, now))).toArray();
    const cost = usage.reduce((sum, row) => sum + row.cost, 0);
    return { email, days, cost, usage };
  }

  /** Public seven-day UTC aggregates. No email addresses leave the Durable Object. */
  async publicReport(now = new Date()) {
    const today = ymd(new Date(now));
    const start = ymd(new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000));
    const sql = this.ctx.storage.sql;
    const firstDate = sql.exec("SELECT MIN(date) AS date FROM provider_usage").toArray()[0]?.date;
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = ymd(new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000));
      const available = firstDate !== null && date >= firstDate;
      return {
        date, complete: date !== today, available,
        total: available ? { spend_usd: 0, input_tokens: 0, output_tokens: 0 } : null,
        providers: available ? {} : null,
        iitm_users: available ? 0 : null,
        users_by_provider_count: available ? { "1": 0, "2": 0, "3+": 0 } : null,
      };
    });
    const byDate = Object.fromEntries(days.map((day) => [day.date, day]));

    for (const row of sql.exec(`
      SELECT date, provider, SUM(spend_usd) AS spend_usd,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
      FROM provider_usage WHERE date BETWEEN ? AND ? GROUP BY date, provider
    `, start, today)) {
      const day = byDate[row.date];
      const values = { spend_usd: row.spend_usd, input_tokens: row.input_tokens, output_tokens: row.output_tokens };
      day.providers[row.provider] = values;
      for (const metric of Object.keys(values)) day.total[metric] += values[metric];
    }
    for (const row of sql.exec(`
      SELECT date, COUNT(DISTINCT email) AS users FROM provider_usage
      WHERE date BETWEEN ? AND ? AND email LIKE '%@%.iitm.ac.in' GROUP BY date
    `, start, today)) byDate[row.date].iitm_users = row.users;

    for (const row of sql.exec(`
      SELECT date, providers_used, COUNT(*) AS users FROM (
        SELECT date, email, COUNT(*) AS providers_used FROM provider_usage
        WHERE date BETWEEN ? AND ? GROUP BY date, email
      ) GROUP BY date, providers_used
    `, start, today)) {
      const bucket = row.providers_used >= 3 ? "3+" : String(row.providers_used);
      byDate[row.date].users_by_provider_count[bucket] += row.users;
    }
    return { schema_version: 1, timezone: "UTC", collection_started_on: firstDate ?? null, days };
  }

  /** Overwrite cost for specific email and date (admin only) */
  async setCost(email, date, cost) {
    await this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cost (email, date, cost) VALUES (?, ?, ?)",
      email,
      date,
      cost,
    );
  }

  /** Get all usage data (admin only) */
  async allUsage() {
    const sql = "SELECT email, date, cost FROM cost ORDER BY date DESC, email";
    return (await this.ctx.storage.sql.exec(sql)).toArray();
  }
}

/** Returns [now - days, now], both as YYYY-MM-DD (UTC) */
function dateRange(days, now) {
  now = now ?? new Date();
  return [ymd(new Date(now - days * 24 * 60 * 60 * 1000)), ymd(now)];
}
