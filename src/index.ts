import { SlackApp, SlackEdgeAppEnv, isPostedMessageEvent } from 'slack-cloudflare-workers';

export default {
	async fetch(request: Request, env: SlackEdgeAppEnv, ctx: ExecutionContext): Promise<Response> {
		const app = new SlackApp({ env }).event('message', async ({ payload }) => {
			if (isPostedMessageEvent(payload)) {
				console.log(`New message: ${payload.text}`);
			}
		});
		return await app.run(request, ctx);
	},
};
