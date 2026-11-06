// The account's plan, which decides the Hacc tools an agent is offered. Hacc checks
// the plan, not the key: Free reads the tape, market, token and wallet data; Pro adds follows, rules,
// personal signals and the account's own groups; Max adds wallet book legs and the strategy lab.
//
// The plan is read from candle_execution_status's `tier`, which the core already reads for each agent
// (agent-status.ts). It's kept fresh in the background, every 5 minutes, whether
// or not a view is attached (the wallets refresh runs only while one is): Hacc learns a change from
// Candle within about a minute (the docs), so the next turn's offer follows it. Until it's read, an
// agent is offered Free's tools, and a call past them is tried anyway and answered by Hacc's 403.

export type HaccPlan = "free" | "pro" | "max"
export const PLAN_REFRESH_MS = 5 * 60_000

const PLANS: readonly HaccPlan[] = ["free", "pro", "max"]
export const reaches = (plan: HaccPlan | undefined, needs: HaccPlan) => PLANS.indexOf(plan ?? "free") >= PLANS.indexOf(needs)

/** What the next plan adds, once, in the prompt's data line (a fact, no pitch). */
export function planLine(plan: HaccPlan | undefined): string {
  if (plan === "max") return "This account is on Max: every Hacc read is open, the strategy lab and wallet book legs included."
  // Told only that the lab needs Max, Grok spent a whole turn's 30 steps looking for it.
  if (plan === "pro") return "This account is on Pro: the strategy lab (backtests, replays, research reports) and wallet book legs need Max. They aren't among your tools, and there's no other way to them: when asked for one, say which plan it needs, rather than looking for it."
  if (plan === "free") return "This account is on Free: follows, alert rules and personal signals need Pro or Max; the strategy lab and wallet book legs need Max. They aren't among your tools, and there's no other way to them: when asked for one, say which plan it needs, rather than looking for it."
  return "This account's plan isn't known yet, so only Free's Hacc reads are offered: follows and rules need Pro or Max, the strategy lab Max."
}

export interface PlanStateDeps {
  status: { get(agent: string): { tier?: string; readAt: number } | undefined; refresh(agent: string): Promise<unknown> }
  agents(): string[]
  now(): number
  onChange?(): void
}

export class PlanState {
  private timer: ReturnType<typeof setInterval> | undefined
  private last = new Map<string, HaccPlan | undefined>()

  constructor(private readonly deps: PlanStateDeps) {}

  /** The agent's account's plan, and when it was read; undefined until a status read names one. */
  planFor(agent: string): { plan: HaccPlan | undefined; readAt: number | undefined } {
    const status = this.deps.status.get(agent)
    const tier = status?.tier
    const plan = PLANS.includes(tier as HaccPlan) ? (tier as HaccPlan) : undefined
    return { plan, readAt: status?.readAt }
  }

  /** Re-reads any agent whose status is older than the refresh period, then reports a change. */
  async refresh(): Promise<void> {
    for (const agent of this.deps.agents()) {
      const readAt = this.deps.status.get(agent)?.readAt
      if (readAt === undefined || this.deps.now() - readAt >= PLAN_REFRESH_MS - 1000) await this.deps.status.refresh(agent).catch(() => undefined)
    }
    this.noticeChanges()
  }

  /** Reports a plan that changed since last looked, whoever read it (the wallets refresh reads it too). */
  noticeChanges(): void {
    let changed = false
    for (const agent of this.deps.agents()) {
      const plan = this.planFor(agent).plan
      if (!this.last.has(agent) || this.last.get(agent) !== plan) changed = true
      this.last.set(agent, plan)
    }
    if (changed) this.deps.onChange?.()
  }

  start(): void {
    this.timer ??= setInterval(() => void this.refresh(), PLAN_REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
