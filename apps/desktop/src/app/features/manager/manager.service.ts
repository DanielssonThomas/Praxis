import { computed, inject, Injectable, signal } from "@angular/core";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import type { ManagerFrame, ManagerMessage, UsageMeasurement, WorkflowError } from "../../native/desktop-bridge.service";
import { managerCards } from "./manager-view.model";
import type { ManagerCardSelection, ManagerTurn } from "./manager-view.model";

const settled = new Set(["completed", "failed", "interrupted", "stopped", "unknown"]);

@Injectable({ providedIn: "root" })
export class ManagerService {
  private readonly native = inject(DesktopBridge);
  private generation = 0;
  private readonly pending = signal<{ turnId: string; prompt: string } | null>(null);
  private readonly selection = signal<ManagerCardSelection | null>(null);
  readonly supported = this.native.available;
  readonly unlocked = signal(false);
  readonly active = signal(false);
  readonly unlocking = signal(false);
  readonly reconnectable = computed(() => this.pending() !== null && !this.active());
  readonly history = signal<readonly ManagerMessage[]>([]);
  readonly turns = signal<readonly ManagerTurn[]>([]);
  readonly selectedCard = this.selection.asReadonly();
  readonly usage = signal<UsageMeasurement | null>(null);
  readonly status = signal(this.supported ? "" : "The desktop Manager connection is unavailable.");

  async unlock(token: string): Promise<void> {
    if (this.unlocking()) return;
    this.unlocking.set(true);
    try {
      const result = await this.native.unlockManager(token);
      if (result.status === "error") {
        this.status.set(this.message(result.error, "The manager connection is unavailable."));
        return;
      }
      if (this.turns().length === 0) this.history.set(result.data);
      this.unlocked.set(true);
      this.status.set(this.pending() ? "Reconnect to continue the current turn." : "");
    } catch {
      this.status.set("The manager connection is unavailable.");
    } finally {
      this.unlocking.set(false);
    }
  }

  async lock(): Promise<void> {
    this.unlocking.set(true);
    this.unlocked.set(false);
    this.generation++;
    this.active.set(false);
    this.status.set("Manager locked.");
    try {
      await this.native.lockManager();
    } catch {
      this.status.set("The manager connection is unavailable.");
    } finally {
      this.unlocking.set(false);
    }
  }

  submit(prompt: string): string | undefined {
    if (!this.supported) return "The desktop Manager connection is unavailable.";
    if (!this.unlocked()) return "Open Manager with the operator token before sending.";
    if (this.pending()) return this.active() ? "Wait for the current turn." : "Reconnect to continue the current turn.";
    const turnId = crypto.randomUUID();
    this.turns.update((turns) => [...turns, {
      id: turnId,
      prompt,
      response: "",
      cards: [],
      dismissedCards: [],
      presentedCards: false,
    }].slice(-24));
    this.pending.set({ turnId, prompt });
    this.usage.set(null);
    void this.reconnect();
  }

  async reconnect(): Promise<void> {
    const request = this.pending();
    if (!request || !this.unlocked() || this.active()) return;
    const generation = ++this.generation;
    this.active.set(true);
    this.status.set("Waiting for the manager…");
    try {
      const result = await this.native.managerTurn(request, (frame) => {
        if (generation === this.generation) this.onFrame(request.turnId, frame);
      });
      if (generation !== this.generation) return;
      if (result.status === "error") {
        if (result.error?.code === "denied" || result.error?.code === "locked") this.unlocked.set(false);
        if (result.error?.code === "invalid_input") this.pending.set(null);
        this.status.set(this.message(result.error, "The manager stream was interrupted. Reconnect to continue."));
      } else if (this.pending()?.turnId === request.turnId) {
        this.status.set("The manager stream was interrupted. Reconnect to continue.");
      }
    } catch {
      if (generation === this.generation) this.status.set("The manager stream was interrupted. Reconnect to continue.");
    } finally {
      if (generation === this.generation) this.active.set(false);
    }
  }

  selectCard(turnId: string, key: string): void {
    this.selection.set({ turnId, key });
  }

  closeCard(): void {
    this.selection.set(null);
  }

  dismiss(turnId: string, card: string): void {
    this.turns.update((turns) => turns.map((turn) => turn.id === turnId ? {
      ...turn,
      cards: turn.cards.filter(({ key }) => key !== card),
      dismissedCards: [...turn.dismissedCards, card],
    } : turn));
    this.closeCard();
  }

  private onFrame(turnId: string, frame: ManagerFrame): void {
    if (frame.kind !== "snapshot") return;
    const { snapshot, usage, resources } = frame;
    const terminal = settled.has(snapshot.status);
    this.usage.set(usage);
    this.turns.update((turns) => turns.map((turn) => {
      if (turn.id !== turnId) return turn;
      const output = snapshot.output;
      const response = output.availability === "available"
        ? (output.truncated ? "Earlier output omitted.\n" : "") + output.text
        : terminal && !turn.response ? output.reason : turn.response;
      if (!resources) return { ...turn, response };
      const cards = managerCards(resources).filter(({ key }) => !turn.dismissedCards.includes(key));
      const selected = this.selection();
      if (selected?.turnId === turn.id && !cards.some(({ key }) => key === selected.key)) {
        this.closeCard();
      }
      if (!turn.presentedCards && cards.length > 0) {
        this.selectCard(turn.id, cards[0].key);
      }
      return { ...turn, response, cards, presentedCards: turn.presentedCards || cards.length > 0 };
    }));
    if (terminal) this.pending.set(null);
    this.status.set(!terminal ? "Receiving manager output…" : snapshot.status === "completed"
      ? "" : `Hermes reported the turn as ${snapshot.status}.`);
  }

  private message(error: WorkflowError | undefined, fallback: string): string {
    return error?.code && typeof error.message === "string" ? error.message : fallback;
  }
}
