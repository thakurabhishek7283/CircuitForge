// Symbol placement maths shared by the layout engine and the renderer. A placed symbol is
// mirrored first (flip: x -> w - x), then rotated clockwise in screen coordinates (y down), then
// moved so the rotated bounding box's top-left corner sits at the placement's (x, y).
import type { Side } from "../gen/contract.ts";

export type Rot = 0 | 90 | 180 | 270;
export const ROTATIONS: readonly Rot[] = [0, 90, 180, 270];

export interface Point {
  x: number;
  y: number;
}

export function toRot(deg: number | undefined): Rot {
  const r = (((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360;
  return r as Rot;
}

/** Size of the bounding box after rotation. */
export function rotatedSize(w: number, h: number, rot: Rot): { width: number; height: number } {
  return rot === 90 || rot === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** A point in symbol coordinates -> the rotated bounding box's coordinates. */
export function transformPoint(p: Point, w: number, h: number, rot: Rot, flip = false): Point {
  const x = flip ? w - p.x : p.x;
  const y = p.y;
  switch (rot) {
    case 0:
      return { x, y };
    case 90:
      return { x: h - y, y: x };
    case 180:
      return { x: w - x, y: h - y };
    case 270:
      return { x: y, y: w - x };
  }
}

const CW: Record<Side, Side> = { left: "top", top: "right", right: "bottom", bottom: "left" };
const MIRROR: Record<Side, Side> = { left: "right", right: "left", top: "top", bottom: "bottom" };
export const OPPOSITE: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };
/** Unit vector pointing out of the symbol through a pin on this side. */
export const OUTWARD: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export function transformSide(side: Side, rot: Rot, flip = false): Side {
  let s = flip ? MIRROR[side] : side;
  for (let r = 0; r < rot; r += 90) s = CW[s];
  return s;
}

/** SVG `transform` for a `<use>` of a w×h symbol placed at (x, y) with rot/flip. */
export function symbolTransform(x: number, y: number, w: number, h: number, rot: Rot, flip = false): string {
  const parts = [`translate(${x} ${y})`];
  if (rot === 90) parts.push(`translate(${h} 0)`, "rotate(90)");
  if (rot === 180) parts.push(`translate(${w} ${h})`, "rotate(180)");
  if (rot === 270) parts.push(`translate(0 ${w})`, "rotate(270)");
  if (flip) parts.push(`translate(${w} 0)`, "scale(-1 1)");
  return parts.join(" ");
}
