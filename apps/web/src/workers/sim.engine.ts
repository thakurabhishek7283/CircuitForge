// Drives ngspice's shared-library API (WASM build, third_party/ngspice/build-wasm.sh) for one
// circuit-core netlist and returns a SimResult. No browser APIs here, so the same code runs in the
// worker and in Node tests.
//
// The deck is handled exactly like the native batch driver (workers/sim_runner/sim_runner/
// ngspice_batch.py), and the cross-runtime test (tools/sim/test_wasm_parity.py) holds both to the
// same results:
// - `.meas` cards are lifted out of the deck and replayed after `run` as interactive `meas`
//   commands against the plot of their own analysis: in a deck, ngspice 47 evaluates them only
//   for the last analysis that ran.
// - Vector names are canonicalised and model-internal vectors are dropped.
import type { Analysis } from "../gen/contract.ts";
import type { SimRequest, SimResult, SimStatus, SimUnit, SimVector } from "./sim.types.ts";

type AnalysisType = Analysis["type"];

/** The parts of the Emscripten module (createNgspice()) the engine uses. */
export interface NgspiceModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string | Uint8Array): void;
    chdir(path: string): void;
  };
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  addFunction(fn: (...args: number[]) => number, signature: string): number;
  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(str: string): number;
  getValue(ptr: number, type: "i8" | "i16" | "i32" | "*" | "double"): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _ngSpice_Init(print: number, stat: number, exit: number, data: number, init: number, bg: number, user: number): number;
  _ngSpice_Circ(lines: number): number;
  _ngSpice_Command(command: number): number;
  _ngGet_Vec_Info(name: number): number;
  _ngSpice_AllPlots(): number;
  _ngSpice_AllVecs(plot: number): number;
}

const ANALYSIS_CARDS: Record<string, AnalysisType> = { ".op": "op", ".dc": "dc", ".ac": "ac", ".tran": "tran" };
// ngspice's simvec types (SV_TIME = 1, SV_FREQUENCY, SV_VOLTAGE, SV_CURRENT); others are dropped.
const UNITS: Record<number, SimUnit> = { 1: "s", 2: "Hz", 3: "V", 4: "A" };
const VF_COMPLEX = 2;
const SCALES = new Set(["time", "frequency", "v-sweep", "i-sweep"]);

// Log lines -> status (first match wins). Kept in step with STATUS_PATTERNS in sim_runner/ngspice_batch.py.
const STATUS_PATTERNS: [RegExp, SimStatus][] = [
  [/singular matrix/i, "singular_matrix"],
  [/timestep too small/i, "no_convergence"],
  [/no convergence|gmin stepping failed|source stepping failed|iteration limit/i, "no_convergence"],
];
const FAILURE = /simulation\(s\) aborted|timestep too small|analysis not run/i;

export interface MeasCard {
  analysis: AnalysisType;
  name: string;
  command: string;
}

export interface Deck {
  /** Netlist lines without `.meas` cards and without `.end`. */
  body: string[];
  /** Analysis of each analysis card, in deck order. */
  analyses: AnalysisType[];
  meas: MeasCard[];
}

export function splitDeck(netlist: string): Deck {
  const deck: Deck = { body: [], analyses: [], meas: [] };
  for (const line of netlist.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    const card = (words[0] ?? "").toLowerCase();
    if (card === ".control" || card === ".endc") throw new Error("netlists must not contain .control sections");
    if (card === ".meas" || card === ".measure") {
      if (words.length < 4) throw new Error(`incomplete .meas card: ${line}`);
      const analysis = words[1]!.toLowerCase() as AnalysisType;
      deck.meas.push({ analysis, name: words[2]!.toLowerCase(), command: "meas " + words.slice(1).join(" ") });
    } else if (card !== ".end") {
      const analysis = ANALYSIS_CARDS[card];
      if (analysis) deck.analyses.push(analysis);
      deck.body.push(line);
    }
  }
  return deck;
}

// ngspice's is_arith_char (misc/string.c).
const ARITH = /[+\-*/()<>?:|&^!%\\]/;

/** Index of the next `=` that is an assignment (not `==`, `!=`, `<=`, `>=`), or -1. */
function findAssignment(s: string, from: number): number {
  for (let i = s.indexOf("=", from); i >= 0; i = s.indexOf("=", i + 1)) {
    if (s[i + 1] === "=") {
      i++;
      continue;
    }
    if (i > 0 && "!<>".includes(s[i - 1]!)) continue;
    return i;
  }
  return -1;
}

/**
 * A `meas` command as ngspice runs it from a `.control` section. Its deck reader
 * (inp_meas_control in frontend/inpcom.c) moves every right-hand side that contains arithmetic,
 * such as `when vdb(out)=ref-3`, into a vector first; `ngSpice_Command` skips the deck reader, so
 * the same rewrite happens here: `let vexprintN=ref-3`, the command, then `unlet vexprintN`.
 */
export function measCommands(command: string, counter: { n: number }): string[] {
  const lets: string[] = [];
  const unlets: string[] = [];
  let line = command;
  let eq = findAssignment(line, 0);
  while (eq >= 0) {
    const m = /^\s*(\S+)/.exec(line.slice(eq + 1));
    if (!m) break;
    const token = m[1]!;
    let next = eq + 1 + m[0].length;
    if (ARITH.test(token)) {
      const name = `vexprint${counter.n++}`;
      lets.push(`let ${name}=${token}`);
      unlets.push(`unlet ${name}`);
      const rest = line.slice(next).replace(/^\s+/, "");
      line = `${line.slice(0, eq)}=${name} ${rest}`.trimEnd();
      next = eq + 1 + name.length;
    }
    eq = findAssignment(line, next);
  }
  return [...lets, line, ...unlets];
}

/** `n_out` (voltage) -> `v(n_out)`, `v1#branch` -> `i(v1)`; `@r1[i]` and scales unchanged. */
export function canonicalName(raw: string, unit: SimUnit): string {
  const n = raw.toLowerCase();
  if (SCALES.has(n) || n.startsWith("@") || n.includes("(")) return n;
  if (n.endsWith("#branch")) return `i(${n.slice(0, -"#branch".length)})`;
  return unit === "V" ? `v(${n})` : n;
}

/** Nodes and devices inside a model subcircuit (`xu1_a.n1`): not in the IR, change with models. */
export function isInternal(raw: string): boolean {
  return raw.includes(".");
}

export function classify(log: string, failed: boolean): SimStatus {
  if (!failed) return "ok";
  for (const [pattern, status] of STATUS_PATTERNS) if (pattern.test(log)) return status;
  return "error";
}

interface VecInfo {
  type: number;
  real: Float64Array;
  imag?: Float64Array;
}

/** One ngspice instance. Not reentrant: ngspice keeps global state. */
export class Ngspice {
  private readonly m: NgspiceModule;
  private lines: string[] = [];
  /** ngspice called its exit callback: its state is unusable and the module must be recreated. */
  broken = false;

  constructor(m: NgspiceModule) {
    this.m = m;
    const print = m.addFunction((ptr: number) => {
      this.lines.push(m.UTF8ToString(ptr).replace(/^std(out|err) ?/, ""));
      return 0;
    }, "iiii");
    const exit = m.addFunction((status: number) => {
      this.broken = true;
      this.lines.push(`ngspice exited (status ${status})`);
      return 0;
    }, "iiiiii");
    m._ngSpice_Init(print, 0, exit, 0, 0, 0, 0);
  }

  writeFile(path: string, text: string): void {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) this.m.FS.mkdirTree(dir);
    this.m.FS.writeFile(path, text);
  }

  chdir(path: string): void {
    this.m.FS.mkdirTree(path);
    this.m.FS.chdir(path);
  }

  takeLog(): string {
    const log = this.lines.join("\n");
    this.lines = [];
    return log;
  }

  command(cmd: string): number {
    return this.withString(cmd, (p) => this.m._ngSpice_Command(p));
  }

  loadCircuit(lines: string[]): number {
    const m = this.m;
    const ptrs = lines.map((l) => this.allocString(l));
    const array = m._malloc(4 * (ptrs.length + 1));
    const view = new Uint32Array(m.HEAPU8.buffer, array, ptrs.length + 1);
    ptrs.forEach((p, i) => (view[i] = p));
    view[ptrs.length] = 0;
    try {
      return m._ngSpice_Circ(array);
    } finally {
      ptrs.forEach((p) => m._free(p));
      m._free(array);
    }
  }

  /** Plot names, oldest first. */
  plots(): string[] {
    return this.stringArray(this.m._ngSpice_AllPlots()).reverse();
  }

  vectorNames(plot: string): string[] {
    return this.withString(plot, (p) => this.stringArray(this.m._ngSpice_AllVecs(p)));
  }

  /** Copies a vector out of the WASM heap (`plot.name` addresses another plot). */
  vector(name: string): VecInfo | undefined {
    const m = this.m;
    const info = this.withString(name, (p) => m._ngGet_Vec_Info(p));
    if (!info) return undefined;
    // struct vector_info (wasm32): char *v_name; int v_type; short v_flags; double *v_realdata;
    // ngcomplex_t *v_compdata; int v_length
    const type = m.getValue(info + 4, "i32");
    const flags = m.getValue(info + 8, "i16");
    const real = m.getValue(info + 12, "*");
    const comp = m.getValue(info + 16, "*");
    const length = m.getValue(info + 20, "i32");
    if (length <= 0) return { type, real: new Float64Array(0) };
    if (flags & VF_COMPLEX && comp) {
      const pairs = new Float64Array(m.HEAPU8.buffer, comp, 2 * length);
      const re = new Float64Array(length);
      const im = new Float64Array(length);
      for (let i = 0; i < length; i++) {
        re[i] = pairs[2 * i]!;
        im[i] = pairs[2 * i + 1]!;
      }
      return { type, real: re, imag: im };
    }
    return { type, real: new Float64Array(m.HEAPU8.buffer, real, length).slice() };
  }

  private allocString(s: string): number {
    const n = this.m.lengthBytesUTF8(s) + 1;
    const p = this.m._malloc(n);
    this.m.stringToUTF8(s, p, n);
    return p;
  }

  private withString<T>(s: string, f: (ptr: number) => T): T {
    const p = this.allocString(s);
    try {
      return f(p);
    } finally {
      this.m._free(p);
    }
  }

  private stringArray(ptr: number): string[] {
    const out: string[] = [];
    if (!ptr) return out;
    for (let i = 0; ; i++) {
      const p = this.m.getValue(ptr + 4 * i, "*");
      if (!p) return out;
      out.push(this.m.UTF8ToString(p));
    }
  }
}

/** Write registry model files (Netlist.includes paths, e.g. `models/tl072.lib`) under `root`. */
export function loadModels(ng: Ngspice, root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) ng.writeFile(`${root}/${path}`, text);
  ng.chdir(root);
}

/** Simulate one netlist. Synchronous: the worker's watchdog lives on the main thread. */
export function simulate(ng: Ngspice, req: SimRequest, now: () => number = () => performance.now()): SimResult {
  const started = now();
  const done = (status: SimStatus, vectors: SimVector[], meas: Record<string, number>, log: string): SimResult => ({
    hash: req.hash,
    vectors,
    meas,
    status,
    log,
    ms: now() - started,
  });

  let deck: Deck;
  try {
    deck = splitDeck(req.netlist);
  } catch (e) {
    return done("error", [], {}, String(e));
  }

  ng.takeLog();
  ng.command("destroy all"); // drop the previous run's plots
  ng.command("remcirc"); // and its circuit (an error on the first run is harmless)
  ng.takeLog();
  const loadFailed = ng.loadCircuit([...deck.body, ".end"]) !== 0;
  const runFailed = loadFailed || ng.broken || ng.command("run") !== 0;

  // Plots of this run, oldest first, matched to the deck's analyses in order of type.
  const byType = new Map<string, string[]>();
  for (const p of ng.plots()) {
    const type = p.replace(/\d+$/, "");
    byType.set(type, [...(byType.get(type) ?? []), p]);
  }
  const used = new Map<string, number>();
  const planned = deck.analyses.map((a) => {
    const k = used.get(a) ?? 0;
    used.set(a, k + 1);
    return { analysis: a, plot: byType.get(a)?.[k] };
  });

  const vectors: SimVector[] = [];
  for (const { analysis, plot } of planned) {
    if (!plot) continue;
    for (const raw of ng.vectorNames(plot)) {
      if (isInternal(raw)) continue;
      const v = ng.vector(`${plot}.${raw}`);
      const unit = v && UNITS[v.type];
      if (!v || !unit || v.real.length === 0) continue;
      const vec: SimVector = { name: canonicalName(raw, unit), analysis, unit, data: v.real };
      if (v.imag) vec.imag = v.imag;
      vectors.push(vec);
    }
  }

  const meas: Record<string, number> = {};
  const counter = { n: 1 };
  for (const card of deck.meas) {
    const plot = planned.find((p) => p.analysis === card.analysis)?.plot;
    if (!plot || ng.broken) continue;
    ng.command(`setplot ${plot}`);
    for (const cmd of measCommands(card.command, counter)) ng.command(cmd);
    const v = ng.vector(`${plot}.${card.name}`);
    if (v && v.real.length > 0) meas[card.name] = v.real[0]!;
  }

  const log = ng.takeLog();
  const failed = runFailed || ng.broken || planned.some((p) => !p.plot) || FAILURE.test(log);
  return done(classify(log, failed), vectors, meas, log);
}
