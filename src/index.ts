import { env } from 'cloudflare:workers';
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
					text: JSON.stringify(await getUserProfile(payload.user || '', context)),
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

	const fieldIds = Object.keys(response.profile.fields || {});

	const cachedFieldsMap = await env.KV.get(
		fieldIds.map((field) => 'field:' + field),
		{ type: 'text' },
	);
	const cachedFields = Object.fromEntries(cachedFieldsMap);

	const fields: Record<string, string> = {};

	for (const [id, label] of Object.entries(cachedFields)) {
		fields[id.replace('field:', '')] = label || '';
	}

	if (Object.entries(cachedFields).filter(([key, value]) => value !== null).length !== fieldIds.length) {
		const teamProfile = await context.client.team.profile.get();
		if (teamProfile.error) {
			throw new Error(`Failed to get team profile: ${teamProfile.error}`);
		}
		const fieldsFromSlack = teamProfile.profile?.fields;
		fieldsFromSlack?.forEach((field) => {
			if (field.id) {
				env.KV.put('field:' + field.id, field.label || '');
				fields[field.id] = field.label || '';
			}
		});
	}

	return {
		...response.profile,
		fields: Object.entries(response.profile.fields || {}).map(([id, data]) => {
			const fieldLabel = fields[id] || id;
			return {
				label: fieldLabel,
				alt: data.alt || '',
				value: data.value || '',
			};
		}),
	};
}
