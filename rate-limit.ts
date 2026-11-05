export const DAY_MS = 24 * 60 * 60 * 1000;

type Entry = { startedAt: number; committed: boolean };

/** Reserves a user's daily run until the work either commits or fails. */
export class DailyRateLimiter {
  private readonly entries = new Map<string, Entry>();

  tryReserve(userId: string, now = Date.now()):
    | { ok: true; release: () => void; commit: () => void }
    | { ok: false; retryAt: number } {
    const previous = this.entries.get(userId);
    if (previous !== undefined && now - previous.startedAt < DAY_MS) {
      return { ok: false, retryAt: previous.startedAt + DAY_MS };
    }

    const entry: Entry = { startedAt: now, committed: false };
    this.entries.set(userId, entry);
    let settled = false;
    return {
      ok: true,
      commit: () => {
        if (settled) return;
        settled = true;
        entry.committed = true;
      },
      release: () => {
        if (settled) return;
        settled = true;
        if (this.entries.get(userId) === entry) this.entries.delete(userId);
      },
    };
  }
}
