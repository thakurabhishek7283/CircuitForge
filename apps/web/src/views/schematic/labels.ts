// Text drawn next to symbols and nets. Values come from the core's parsed quantities (`display`),
// never re-parsed here.
import type { PartDef, PartInstance } from "../../gen/contract.ts";

/**
 * The value line under a part's name: its non-zero params ("10kΩ", "1V 1kHz"), or for parts
 * without params the type number from the title ("TL072", "2N3904").
 */
export function partValue(inst: PartInstance, def: PartDef | undefined): string {
  const shown = Object.keys(def?.params ?? inst.params)
    .map((k) => inst.params[k])
    .filter((q) => q !== undefined && q.si !== 0)
    .map((q) => q!.display);
  if (shown.length) return shown.join(" ");
  const first = def?.title.split(/[\s,]/)[0] ?? "";
  return /[A-Za-z]/.test(first) && /\d/.test(first) ? first : "";
}

/** `U1` plus the unit letter for multi-unit parts: `U1A`. */
export function partName(refdes: string, unit: string | null): string {
  return unit ? refdes + unit : refdes;
}

/** Three significant figures, mV below 1 V. */
export function formatVolts(v: number): string {
  const sig3 = (x: number) => x.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const a = Math.abs(v);
  if (a < 5e-4) return "0 V";
  return a < 1 ? `${sig3(v * 1e3)} mV` : `${sig3(v)} V`;
}

const PREFIXES: [number, string][] = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];

/** Three significant figures with an SI prefix: `formatSi(0.0047, "A")` is "4.7 mA". */
export function formatSi(v: number, unit: string): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a < 1e-15) return `0 ${unit}`;
  const [scale, prefix] = PREFIXES.find(([s]) => a >= s * 0.9995) ?? PREFIXES.at(-1)!;
  const x = (v / scale).toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${x} ${prefix}${unit}`;
}
