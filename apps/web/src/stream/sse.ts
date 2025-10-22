// A Server-Sent Events parser for text arriving in arbitrary chunks (the WHATWG event-stream
// format): lines end with CRLF, LF or CR; `data` lines join with "\n"; a blank line dispatches;
// lines starting with ":" are comments (keep-alives). The job stream reads it over fetch, not
// EventSource, so it can send an Authorization header (LLD §5).

export interface SseEvent {
  /** The event's `id` field, if it had one (the job stream's heartbeats have none). */
  id: string | null;
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";
  /** A chunk ended on CR: a following LF belongs to the same line ending. */
  private pendingCr = false;
  private id: string | null = null;
  private event = "";
  private data: string[] = [];
  private hasData = false;

  /** Feed decoded text; returns the events it completed. */
  feed(chunk: string): SseEvent[] {
    if (this.pendingCr && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.pendingCr = false;
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      this.line(this.buffer.slice(start, i), out);
      if (c === "\r") {
        if (i + 1 === this.buffer.length) this.pendingCr = true;
        else if (this.buffer[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.hasData || this.event) out.push({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
      this.id = null;
      this.event = "";
      this.data = [];
      this.hasData = false;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.data.push(value);
      this.hasData = true;
    } else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }
}
