import { describe, expect, it } from "vitest";
import type { PartDef, PartInstance } from "../../gen/contract.ts";
import { formatVolts, partValue } from "./labels.ts";

const q = (si: number, display: string) => ({ si, display, unit: "volt" as const });

describe("labels", () => {
  it("formats voltages to three significant figures", () => {
    expect(formatVolts(12)).toBe("12 V");
    expect(formatVolts(-11.987)).toBe("-12 V");
    expect(formatVolts(1.23456)).toBe("1.23 V");
    expect(formatVolts(0.1)).toBe("100 mV");
    expect(formatVolts(-0.0123)).toBe("-12.3 mV");
    expect(formatVolts(1e-6)).toBe("0 V");
  });

  it("shows non-zero params, or the type number", () => {
    const sine = { title: "Sine signal source", params: { offset: {}, amplitude: {}, frequency: {} } } as unknown as PartDef;
    const inst = {
      params: { amplitude: q(1, "1V"), frequency: { si: 1000, display: "1kHz", unit: "hertz" }, offset: q(0, "0V") },
    } as unknown as PartInstance;
    expect(partValue(inst, sine)).toBe("1V 1kHz");
    const opamp = { title: "TL072 dual JFET op-amp", params: {} } as unknown as PartDef;
    expect(partValue({ params: {} } as unknown as PartInstance, opamp)).toBe("TL072");
    const led = { title: "Red LED, 5 mm", params: {} } as unknown as PartDef;
    expect(partValue({ params: {} } as unknown as PartInstance, led)).toBe("");
  });
});
