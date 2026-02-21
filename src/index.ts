import { SlackApp, SlackEdgeAppEnv, isPostedMessageEvent } from 'slack-cloudflare-workers';

export default {
	async fetch(request: Request, env: SlackEdgeAppEnv, ctx: ExecutionContext): Promise<Response> {
		const app = new SlackApp({ env }).event('message', async ({ payload, context }) => {
			if (isPostedMessageEvent(payload) && payload.channel === process.env.CHANNEL_ID && !payload.thread_ts) {
				await context.client.chat.postMessage({
					channel: process.env.CHANNEL_ID,
					thread_ts: payload.ts,
					text: 'Test',
				});
				console.log(`New message: ${payload.text}`);
			}
		});
		return await app.run(request, ctx);
	},
};
