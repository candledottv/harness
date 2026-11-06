// Reads Hacc refused for the account's plan, held back until the plan changes. Candle's plan table can
// say a plan reaches a read Hacc then refuses ("Stored intelligence requires Pro or Max"): offering it again
// each turn sends the agent to the same refusal, and Research would ask again every minute. Hacc's answer
// wins over the table, for as long as the plan it was given on stands.
import type { HaccPlan } from "./plan-state"

export class PlanHeld {
  /** Each held read, by its key (`hacc_token token`, `research traders`), with the plan Hacc refused it on. */
  private readonly held = new Map<string, HaccPlan | undefined>()

  constructor(private readonly onChange?: () => void) {}

  /** Hacc refused `key` for the plan: held while the account stays on `plan`. */
  hold(key: string, plan: HaccPlan | undefined): void {
    if (this.held.has(key) && this.held.get(key) === plan) return
    this.held.set(key, plan)
    this.onChange?.()
  }

  /** Whether `key` is held on `plan`. A plan that changed since lets every read go again. */
  isHeld(key: string, plan: HaccPlan | undefined): boolean {
    if (!this.held.has(key)) return false
    if (this.held.get(key) === plan) return true
    this.held.delete(key)
    return false
  }

  /** The keys held on `plan`, in the order Hacc refused them. */
  keys(plan: HaccPlan | undefined): string[] {
    return [...this.held.keys()].filter((k) => this.isHeld(k, plan))
  }
}
