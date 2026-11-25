import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.ts";

// A request someone made in the channel that hasn't been answered yet.
export type Request = {
  channel: string;
  ts: string;
  user: string;
  text?: string;
};

// Requests waiting in the queue or running, in arrival order. Saved to disk so
// a restart (e.g. a redeploy) can pick them back up instead of dropping them.
const file = join(env.STATE_DIR, "pending.json");
mkdirSync(env.STATE_DIR, { recursive: true });

let pending: Request[] = [];
try {
  pending = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error("failed to read pending requests, starting empty", error);
  }
}

const same = (a: Request, b: Request) =>
  a.channel === b.channel && a.ts === b.ts;

function save() {
  // Write then rename, so a crash mid-write can't leave a truncated file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending));
  renameSync(tmp, file);
}

// Requests left over from the previous process, oldest first.
export const loadPending = (): Request[] => [...pending];

export function addPending(request: Request) {
  if (pending.some((p) => same(p, request))) return;
  pending.push(request);
  save();
}

export function removePending(request: Request) {
  const before = pending.length;
  pending = pending.filter((p) => !same(p, request));
  if (pending.length !== before) save();
}
