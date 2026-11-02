/**
 * Per-item corpus results as JSONL: a header line, then one line per item, written as each item finishes. A whole-run
 * JSON.stringify of a shard (≈ 8k items with every official error) does not fit the run's memory cap.
 * readResults also reads the older single-document form.
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";

type Res = Record<string, any>;

export class ResultWriter {
  private readonly fd: number;

  constructor(file: string, header: Res) {
    this.fd = openSync(file, "w");
    writeSync(this.fd, `${JSON.stringify(header)}\n`);
  }

  add(item: unknown): void {
    writeSync(this.fd, `${JSON.stringify(item)}\n`);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Calls `onItem` for every item of a results file. */
export function readResults(file: string, onItem: (item: Res) => void): void {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(1 << 22);
  const parts: Buffer[] = [];
  let lineNo = 0;
  const line = (b: Buffer): void => {
    if (b.length === 0) return;
    const r = JSON.parse(b.toString("utf8")) as Res;
    if (lineNo++ === 0 && Array.isArray(r.results)) for (const it of r.results as Res[]) onItem(it);
    else if (lineNo > 1) onItem(r);
  };
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    let from = 0;
    for (let nl = buf.indexOf(10, from); nl !== -1 && nl < n; nl = buf.indexOf(10, from)) {
      line(Buffer.concat([...parts, buf.subarray(from, nl)]));
      parts.length = 0;
      from = nl + 1;
    }
    if (from < n) parts.push(Buffer.from(buf.subarray(from, n)));
  }
  line(Buffer.concat(parts));
  closeSync(fd);
}
