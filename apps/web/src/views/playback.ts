// Where the transient playback is: the overlays animate the short transient in a loop (current
// dots, voltage colours) and the scope draws a cursor at the same instant. A plain mutable object
// read inside requestAnimationFrame loops, never React state.
export class Playback {
  /** Position in the transient, 0..1. */
  phase = 0;
}
