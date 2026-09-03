import { WebClient } from "@slack/web-api";
import type { SDKCustomTool } from "@cursor/sdk";

/**
 * Slack WebClient backed by the user (xoxp) token. search.messages needs a user
 * token — the Bolt app's own client uses the bot token (xoxb), which cannot
 * call search.messages — so we use a separate client here.
 */
const client = new WebClient(process.env.SLACK_USER_TOKEN!);

/**
 * Search Slack messages via the WebClient (the same SDK @slack/bolt uses).
 * https://api.slack.com/methods/search.messages
 */
export const slackSearchTool: SDKCustomTool = {
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
      sort: { type: "string", enum: ["timestamp", "score"], default: "timestamp" },
      sort_dir: { type: "string", enum: ["asc", "desc"], default: "desc" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query ?? "");
    const body: any = await client.search.messages({
      query,
      count: Math.min(Math.max(Number(args.count ?? 20), 1), 100),
      page: Math.max(Number(args.page ?? 1), 1),
      sort: args.sort === "score" ? "score" : "timestamp",
      sort_dir: args.sort_dir === "asc" ? "asc" : "desc",
    });

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
};
