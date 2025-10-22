// The AnimationDirector (LLD §10): a generation job's events play in the order they arrived, at
// the learner's pace, however fast the network delivers them. A block's envelopes are each applied
// by the WASM core (which checks `base_rev`, so a gap or a version skew is caught before anything
// is drawn), laid out once, then revealed op by op: parts scale in, wires draw, the frame turns
// solid at `block.commit`. Ghosts, narration, repairs and spec results go to the generation store
// in the same order, so the panel never runs ahead of the drawing.
import type { JobEvent, JobState, OpEnvelope } from "../gen/contract.ts";
import type { CircuitStore } from "../store/circuitStore.ts";
import type { GenerationStore } from "../store/generationStore.ts";

export type RevealItem = { kind: "part"; refdes: string } | { kind: "net"; id: string } | { kind: "block"; id: string };

/** The drawing side: the DOM with the Web Animations API in the app (stage.ts), instant in tests. */
export interface Stage {
  /** Keep these out of sight until they are revealed (called before their ops are applied). */
  hide(items: RevealItem[]): void;
  /** Animate one in; resolves when its animation has finished. */
  reveal(item: RevealItem): Promise<void>;
  /** Show everything still hidden, finishing what is animating. */
  revealAll(): void;
  /** A block whose ops are playing has a dashed frame. */
  building(block: string, on: boolean): void;
  setSpeed(speed: number): void;
  setPaused(paused: boolean): void;
}

export const instantStage: Stage = {
  hide() {},
  reveal: async () => {},
  revealAll() {},
  building() {},
  setSpeed() {},
  setPaused() {},
};

export interface DirectorOptions {
  store: CircuitStore;
  gen: GenerationStore;
  /** Resolves once the drawing shows `rev` (the layout runs in a worker). */
  waitForLayout: (rev: number) => Promise<void>;
  /** The local circuit cannot follow the server's (a refused op, a gap): reload the project. */
  onResync: (reason: string) => void;
  /** A block's ops are in the circuit, which is now at `rev` (the server's rev too). */
  onApplied?: (rev: number) => void;
  /** The stream ended (`done` or `error`) and everything before it has played. */
  onFinished?: (event: Extract<JobEvent, { event: "done" | "error" }>) => void;
}

type OpEvent = Extract<JobEvent, { event: "op" }>;

/** What a block's ops add to the drawing, in op order: its parts, and the nets it connects. */
export function revealItems(envelopes: OpEnvelope[]): RevealItem[] {
  const items: RevealItem[] = [];
  const nets = new Set<string>();
  for (const env of envelopes) {
    if (env.op === "part.add") items.push({ kind: "part", refdes: env.body.refdes });
    else if (env.op === "net.connect" && !nets.has(env.body.net)) {
      nets.add(env.body.net);
      items.push({ kind: "net", id: env.body.net });
    }
  }
  return items;
}

export class AnimationDirector {
  private stage: Stage = instantStage;
  private readonly queue: JobEvent[] = [];
  private wake: (() => void) | null = null;
  private unpause: (() => void) | null = null;
  private drained: (() => void)[] = [];
  private busy = false;
  private disposed = false;
  private finalState: JobState | null = null;
  private readonly unsubscribe: () => void;
  private readonly opts: DirectorOptions;

  constructor(opts: DirectorOptions) {
    this.opts = opts;
    this.unsubscribe = opts.gen.subscribe((s, prev) => {
      if (s.speed !== prev.speed) this.stage.setSpeed(s.speed);
      if (s.paused !== prev.paused) {
        this.stage.setPaused(s.paused);
        if (!s.paused) this.unpause?.();
      }
      if (s.skipping && !prev.skipping) this.stage.revealAll();
    });
    void this.loop();
  }

  setStage(stage: Stage | null): void {
    this.stage.revealAll();
    this.stage = stage ?? instantStage;
    const { speed, paused } = this.opts.gen.getState();
    this.stage.setSpeed(speed);
    this.stage.setPaused(paused);
  }

  push(event: JobEvent): void {
    if (event.event === "heartbeat") return;
    this.queue.push(event);
    this.wake?.();
  }

  /** Resolves when every event pushed so far has played. */
  idle(): Promise<void> {
    if (!this.busy && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.wake?.();
    this.unpause?.();
  }

  private next(): Promise<JobEvent | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve(this.disposed ? null : this.queue.shift()!);
      };
    });
  }

  private async unpaused(): Promise<void> {
    while (this.opts.gen.getState().paused && !this.disposed) {
      await new Promise<void>((resolve) => (this.unpause = resolve));
    }
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (!this.queue.length) {
        this.busy = false;
        for (const d of this.drained.splice(0)) d();
      }
      const e = await this.next();
      if (!e) return;
      this.busy = true;
      try {
        await this.unpaused();
        await this.play(e);
      } catch (err) {
        console.error("AnimationDirector:", err);
        this.opts.onResync(`could not play ${e.event}: ${(err as Error).message}`);
      }
    }
  }

  private async play(e: JobEvent): Promise<void> {
    const { gen, store } = this.opts;
    switch (e.event) {
      case "job.state":
        if (["done", "failed", "cancelled"].includes(e.data.state)) this.finalState = e.data.state;
        gen.getState().setState(e.data.state, e.data.block ?? null);
        return;
      case "narration.delta":
        gen.getState().narrate(e.data.block ?? null, e.data.text);
        if (e.data.block) gen.getState().setSpeaking(e.data.block);
        return;
      case "block.ghost":
        // After a reload the stream replays from the start: a ghost of a block the snapshot
        // already holds is history.
        if (!store.getState().blocks[e.data.id]) gen.getState().addGhost(e.data);
        gen.getState().setSpeaking(null); // the story moves on to the next block
        return;
      case "block.repair":
        gen.getState().repair(e.data);
        return;
      case "sim.summary":
        store.getState().setBench(e.data.block, e.data.checks);
        return;
      case "op":
        return this.block(e);
      case "error":
        this.stage.revealAll();
        gen.getState().finish("failed", e.data);
        this.opts.onFinished?.(e);
        return;
      case "done":
        this.stage.revealAll();
        gen.getState().finish(this.finalState === "cancelled" ? "cancelled" : "done");
        if (e.data.rev !== store.getState().rev) this.opts.onResync(`the job ended at rev ${e.data.rev}, the editor is at ${store.getState().rev}`);
        this.opts.onFinished?.(e);
        return;
      case "heartbeat":
        return;
    }
  }

  /** One transaction: `block.begin` up to its `block.commit` (or a single op outside a block). */
  private async block(first: OpEvent): Promise<void> {
    const envelopes = [first.data];
    const later: JobEvent[] = [];
    if (first.data.op === "block.begin") {
      while (envelopes.at(-1)!.op !== "block.commit") {
        const e = await this.next();
        if (!e) return;
        if (e.event === "op") envelopes.push(e.data);
        else later.push(e); // nothing else is sent inside a block; keep the order if it ever is
      }
    }
    const { store, gen } = this.opts;
    const rev = store.getState().rev;
    const base = envelopes[0]!.base_rev;
    const id = first.data.op === "block.begin" ? first.data.body.id : null;
    const title = first.data.op === "block.begin" ? first.data.body.title : first.data.op;
    if (base + envelopes.length <= rev) {
      if (id) gen.getState().committed(id, title); // already in the snapshot this editor opened
    } else if (base !== rev) {
      this.opts.onResync(`ops from rev ${base} reached an editor at rev ${rev}`);
    } else {
      await this.apply(envelopes, id, title);
    }
    for (const e of later) await this.play(e);
  }

  private async apply(envelopes: OpEnvelope[], id: string | null, title: string): Promise<void> {
    const { store, gen } = this.opts;
    const items = revealItems(envelopes);
    const animate = !gen.getState().skipping;
    gen.getState().setSpeaking(null);
    // A net the circuit already has (a port joining an earlier block) stays visible and is redrawn.
    const nets = store.getState().nets;
    const hidden = items.filter((i) => i.kind !== "net" || !nets[i.id]);
    if (animate) this.stage.hide(id ? [{ kind: "block", id }, ...hidden] : hidden);
    const r = store.getState().applyRemote(envelopes, id ? `Generate ${title}` : null);
    if (r.err) {
      this.stage.revealAll();
      this.opts.onResync(`the local core refused a server op: ${r.err.code}: ${r.err.message}`);
      return;
    }
    this.opts.onApplied?.(r.ok.rev);
    await this.opts.waitForLayout(r.ok.rev);
    if (id) gen.getState().committed(id, title);
    if (!animate) return;
    if (id) {
      this.stage.building(id, true);
      await this.stage.reveal({ kind: "block", id });
    }
    for (const item of items) {
      if (gen.getState().skipping || this.disposed) break;
      await this.unpaused();
      await this.stage.reveal(item);
    }
    this.stage.revealAll();
    if (id) this.stage.building(id, false);
  }
}
