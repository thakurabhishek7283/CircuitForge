import { describe, expect, it } from "vitest";
import { canonicalName, classify, isInternal, measCommands, splitDeck } from "./sim.engine.ts";

describe("splitDeck", () => {
  it("lifts .meas cards out and records analyses in order", () => {
    const deck = splitDeck("* t\nR1 a 0 1\n.op\n.tran 1u 1m\n.ac dec 1 1 10\n.meas ac x find vdb(a) at=1\n.end\n");
    expect(deck.analyses).toEqual(["op", "tran", "ac"]);
    expect(deck.meas).toEqual([{ analysis: "ac", name: "x", command: "meas ac x find vdb(a) at=1" }]);
    expect(deck.body.some((l) => /^\.(meas|end)/i.test(l))).toBe(false);
  });

  it("refuses .control sections", () => {
    expect(() => splitDeck("* t\n.control\nshell ls\n.endc\n.end\n")).toThrow(/control/);
  });
});

describe("measCommands (ngspice inp_meas_control)", () => {
  it("moves arithmetic right-hand sides into vectors", () => {
    expect(measCommands("meas ac fc when vdb(n_out)=g_pass-3", { n: 1 })).toEqual([
      "let vexprint1=g_pass-3",
      "meas ac fc when vdb(n_out)=vexprint1",
      "unlet vexprint1",
    ]);
  });

  it("leaves plain numbers and names alone and numbers each expression", () => {
    const counter = { n: 7 };
    expect(measCommands("meas tran x avg v(a) from=1m to=2m", counter)).toEqual(["meas tran x avg v(a) from=1m to=2m"]);
    expect(measCommands("meas tran y when v(a)=ref rise=2 td=t0*2", counter)).toEqual([
      "let vexprint7=t0*2",
      "meas tran y when v(a)=ref rise=2 td=vexprint7",
      "unlet vexprint7",
    ]);
    expect(counter.n).toBe(8);
  });
});

describe("names and status", () => {
  it("canonicalises vector names like the native driver", () => {
    expect(canonicalName("N_OUT", "V")).toBe("v(n_out)");
    expect(canonicalName("v1#branch", "A")).toBe("i(v1)");
    expect(canonicalName("@r1[i]", "A")).toBe("@r1[i]");
    expect(canonicalName("frequency", "Hz")).toBe("frequency");
    expect(canonicalName("v-sweep", "V")).toBe("v-sweep");
    expect(isInternal("xu1_a.n1") && !isInternal("n_out")).toBe(true);
  });

  it.each([
    ["anything", false, "ok"],
    ["Warning: singular matrix:  check node n_a\nop simulation(s) aborted", true, "singular_matrix"],
    ["doAnalyses: TRAN:  Timestep too small; time = 1e-3", true, "no_convergence"],
    ["Warning: source stepping failed\nrun simulation(s) aborted", true, "no_convergence"],
    ["Error on line 3: unknown model", true, "error"],
  ] as const)("maps %j to %s", (log, failed, status) => {
    expect(classify(log, failed)).toBe(status);
  });
});
