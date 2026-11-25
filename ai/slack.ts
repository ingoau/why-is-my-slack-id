import {
  ErrorCode,
  WebClient,
  type SearchMessagesArguments,
  type SearchMessagesResponse,
} from "@slack/web-api";
import type { SDKCustomTool } from "@cursor/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import { env } from "../env.ts";

/**
 * Slack WebClient backed by the user (xoxp) token. search.messages needs a user
 * token — the Bolt app's own client uses the bot token (xoxb), which cannot
 * call search.messages — so we use a separate client here.
 *
 * Rate limits are handled by the queue below rather than the client: the
 * client's own retry would leave abandoned calls retrying for up to 30 min.
 */
const client = new WebClient(env.SLACK_USER_TOKEN, {
  rejectRateLimitedCalls: true,
  retryConfig: { retries: 2 },
  timeout: 30_000,
});

// search.messages is Tier 2 (~20/min) and every run shares the one user
// token, so all searches go through a single queue, one at a time, spaced to
// stay under the limit. A 429 pauses the whole queue for Slack's retry-after.
const SEARCH_INTERVAL_MS = 3_000;

type SearchJob = {
  params: SearchMessagesArguments;
  signal?: AbortSignal;
  resolve: (body: SearchMessagesResponse) => void;
  reject: (error: unknown) => void;
};

const searchQueue: SearchJob[] = [];
let pumping = false;
let nextCallAt = 0;

function queueSearch(
  params: SearchMessagesArguments,
  signal?: AbortSignal,
): Promise<SearchMessagesResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    // The run was cancelled: drop the search if it hasn't been sent yet.
    const onAbort = () => {
      const i = searchQueue.indexOf(job);
      if (i === -1) return;
      searchQueue.splice(i, 1);
      reject(signal?.reason);
    };
    const job: SearchJob = {
      params,
      signal,
      resolve: (body) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(body);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    searchQueue.push(job);
    void pumpSearchQueue();
  });
}

async function pumpSearchQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (searchQueue.length > 0) {
      const wait = nextCallAt - Date.now();
      if (wait > 0) await sleep(wait);
      // Jobs may have been cancelled while we waited.
      const job = searchQueue.shift();
      if (!job) break;
      nextCallAt = Date.now() + SEARCH_INTERVAL_MS;
      try {
        job.resolve(await client.search.messages(job.params));
      } catch (error) {
        const rateLimit = error as { code?: string; retryAfter?: number };
        if (rateLimit.code !== ErrorCode.RateLimitedError) {
          job.reject(error);
          continue;
        }
        const retryAfterSec = rateLimit.retryAfter ?? 30;
        nextCallAt = Date.now() + retryAfterSec * 1000;
        console.warn("search rate limited, pausing queue", {
          retryAfterSec,
          queued: searchQueue.length + 1,
        });
        // Retry this search first once the pause is over.
        if (job.signal?.aborted) job.reject(job.signal.reason);
        else searchQueue.unshift(job);
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Search Slack messages via the WebClient (the same SDK @slack/bolt uses).
 * https://api.slack.com/methods/search.messages
 *
 * `signal` is the run's: once it aborts, its queued searches are dropped.
 */
export const createSlackSearchTool = (signal?: AbortSignal): SDKCustomTool => ({
  description:
    "Search Slack messages across the workspace. Supports Slack search query syntax: " +
    "'from:<user_id>', 'in:<channel>', 'after:<date>', 'before:<date>', 'on:<date>', " +
    "and text terms. Combine filters with spaces.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "number", default: 20 },
      page: { type: "number", default: 1 },
      sort: {
        type: "string",
        enum: ["timestamp", "score"],
        default: "timestamp",
      },
      sort_dir: { type: "string", enum: ["asc", "desc"], default: "desc" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query ?? "");
    const body: any = await queueSearch(
      {
        query,
        count: Math.min(Math.max(Number(args.count ?? 20), 1), 100),
        page: Math.max(Number(args.page ?? 1), 1),
        sort: args.sort === "score" ? "score" : "timestamp",
        sort_dir: args.sort_dir === "asc" ? "asc" : "desc",
      },
      signal,
    );

    const matches = (body.messages?.matches ?? []).map((m: any) => ({
      text: m.text,
      user: m.user,
      username: m.username,
      ts: m.ts,
      permalink: m.permalink,
      channel: m.channel
        ? {
            id: m.channel.id,
            name: m.channel.name,
            is_im: m.channel.is_im,
            is_mpim: m.channel.is_mpim,
            is_private: m.channel.is_private,
          }
        : null,
    }));

    return {
      ok: Boolean(body.ok),
      error: body.ok ? null : (body.error ?? "unknown_slack_error"),
      query,
      total: body.messages?.total ?? matches.length,
      paging: body.messages?.paging ?? null,
      matches,
    };
  },
});
