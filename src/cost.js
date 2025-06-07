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
    `);
  }

  /** Add cost to email's usage for today's date */
  async add(email, cost) {
    const date = ymd(new Date());
    const result = await this.ctx.storage.sql.exec("SELECT cost FROM cost WHERE email = ? AND date = ?", email, date);
    const existing = result.toArray();
    const sql = "INSERT OR REPLACE INTO cost (email, date, cost) VALUES (?, ?, ?)";
    await this.ctx.storage.sql.exec(sql, email, date, (existing[0]?.cost || 0) + cost);
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
