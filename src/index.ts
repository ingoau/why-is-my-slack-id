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
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText } from 'ai';
import { PROMPT } from './constants';

export default {
	async fetch(request: Request, env: SlackEdgeAppEnv, ctx: ExecutionContext): Promise<Response> {
		const openrouter = createOpenRouter({
			apiKey: process.env.OPENROUTER_API_KEY,
		});

		const app = new SlackApp({ env }).event('message', async ({ payload, context }) => {
			if (isPostedMessageEvent(payload) && payload.channel === process.env.CHANNEL_ID && !payload.thread_ts) {
				const userProfile = await getUserProfile(payload.user || '', context);
				const response = await generateText({
					model: openrouter('openai/gpt-oss-120b'),
					providerOptions: {
						openrouter: {
							provider: {
								order: ['cerebras', 'groq'],
							},
							reasoning: {
								effort: 'high',
							},
						},
					},
					messages: [
						{ role: 'system', content: PROMPT },
						{ role: 'user', content: `Slack ID: ${payload.user}` },
						{ role: 'user', content: `User Info: ${JSON.stringify(userProfile)}` },
					],
				});
				await context.client.chat.postMessage({
					channel: process.env.CHANNEL_ID,
					thread_ts: payload.ts,
					text: response.text,
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

	const {
		image_1024,
		image_192,
		image_24,
		image_32,
		image_48,
		image_512,
		image_72,
		image_original,
		real_name_normalized,
		display_name_normalized,
		skype,
		status_emoji_display_info,
		avatar_hash,
		status_text_canonical,
		...cleanedProfile
	} = response.profile;

	return {
		...cleanedProfile,
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
