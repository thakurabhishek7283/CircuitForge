// The schematic's markup for the demo's real layout, rendered on the server (no DOM needed).
import ELK from "elkjs/lib/elk.bundled.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PartInstance } from "../../gen/contract.ts";
import { bundle, demo, missingArtifacts } from "../../test/artifacts.ts";
import { LayoutEngine } from "../../workers/layout.engine.ts";
import { layoutRegistry, toLayoutInput } from "../../workers/layoutClient.ts";
import { SchematicContent, SymbolDefs } from "./Schematic.tsx";

const missing = missingArtifacts();

describe.skipIf(missing.length > 0)("schematic", () => {
  it("draws every symbol with <use>, wires, flags, labels and live voltages", async () => {
    const reg = bundle();
    const c = demo();
    const layout = await new LayoutEngine(layoutRegistry(reg), new ELK()).layout(toLayoutInput(c));
    const html = renderToStaticMarkup(
      <svg>
        <SchematicContent
          layout={layout}
          parts={c.parts as Record<string, PartInstance>}
          defs={reg.parts}
          voltages={{ N_OUT: 0.5, VCC: 12 }}
          selection={{ kind: "part", refdes: "R1" }}
          onSelect={() => {}}
        />
      </svg>,
    );
    expect(html.match(/<g class="part[^"]*" data-refdes=/g)).toHaveLength(8);
    expect(html).toContain('href="#sym-opamp"');
    expect(html).toContain('href="#sym-flag_ground"');
    expect(html).toContain('<g class="part selected" data-refdes="R1">');
    expect(html).toContain(">U1A</text>");
    expect(html).toContain(">TL072</text>");
    expect(html).toContain(">1V 1kHz</text>");
    expect(html).toContain(">500 mV</text>");
    expect(html).toContain(">12 V</text>");
    expect(html).toContain(">Sallen-Key low-pass</text>");
    expect(html.match(/class="wire"/g)!.length).toBeGreaterThan(4);
  });

  it("inlines the sprite sheet's symbols", () => {
    const sprite = '<svg xmlns="http://www.w3.org/2000/svg">\n<symbol id="sym-x" viewBox="0 0 10 10"><path d="M0 0"/></symbol>\n</svg>\n';
    const html = renderToStaticMarkup(<SymbolDefs sprite={sprite} />);
    expect(html).toContain('<defs>\n<symbol id="sym-x" viewBox="0 0 10 10"><path d="M0 0"/></symbol>\n</defs>');
  });
});
