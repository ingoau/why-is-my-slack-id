import {
	AuthorizeResult,
	ChatPostMessageRequest,
	ChatPostMessageResponse,
	PreAuthorizeSlackAppContext,
	SlackAPIClient,
	SlackApp,
	SlackEdgeAppEnv,
	isPostedMessageEvent,
} from 'slack-cloudflare-workers';

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

async function getUserProfile(
	userId: string,
	context: PreAuthorizeSlackAppContext & {
		client: SlackAPIClient;
		botToken: string;
		botId: string;
		botUserId: string;
		userToken?: string;
		authorizeResult: AuthorizeResult;
	} & {
		channelId: string;
		say: (params: Omit<ChatPostMessageRequest, 'channel'>) => Promise<ChatPostMessageResponse>;
	},
) {
	const response = await context.client.users.profile.get({ user: userId });
	if (response.error) {
		throw new Error(`Failed to get user profile: ${response.error}`);
	}
	if (!response.profile) {
		throw new Error(`User not found`);
	}
	return {
		...response.profile,
	};
}
