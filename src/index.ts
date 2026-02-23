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
		// Create Openrouter client
		const openrouter = createOpenRouter({
			apiKey: process.env.OPENROUTER_API_KEY,
		});

		// Create slack-cloudflare-workers app
		const app = new SlackApp({ env }).event('message', async ({ payload, context }) => {
			// If message meets requirements (if it is a message, if it in the right channel, and if it isn't in a thread)
			if (isPostedMessageEvent(payload) && payload.channel === process.env.CHANNEL_ID && !payload.thread_ts) {
				// Don't allow bots to trigger
				if ('bot_id' in payload) return;

				// Allow sending messages without bot responding
				if (payload.text.startsWith('#')) return;

				try {
					// Fetch user profile
					if (!payload.user) {
						throw new Error('User ID not provided');
					}
					const userProfile = await getUserProfile(payload.user, context);

					// Ask AI
					const response = await generateText({
						model: openrouter('google/gemini-3-flash-preview'),
						providerOptions: {
							openrouter: {
								reasoning: {
									// This works best
									effort: 'medium',
								},
							},
						},
						messages: [
							{ role: 'system', content: PROMPT },
							{ role: 'user', content: `Slack ID: ${payload.user}` },
							{ role: 'user', content: `User Info: ${JSON.stringify(userProfile)}` },
						],
					});

					// Send response back
					await context.client.chat.postMessage({
						channel: process.env.CHANNEL_ID,
						thread_ts: payload.ts,
						text: response.text,
					});
				} catch {
					await context.client.chat.postMessage({
						channel: process.env.CHANNEL_ID,
						thread_ts: payload.ts,
						text: 'Something went wrong cc <@U0923H02Y3B>',
					});
				}
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
	// Fetch user profile from slack
	const response = await context.client.users.profile.get({ user: userId });
	// If fails
	if (response.error) {
		throw new Error(`Failed to get user profile: ${response.error}`);
	}
	// If profile is null
	if (!response.profile) {
		throw new Error(`User not found`);
	}

	// Get field IDs used in profile
	const fieldIds = Object.keys(response.profile.fields || {});

	// Fetch from KV
	const cachedFieldsMap = await env.KV.get(
		fieldIds.map((field) => 'field:' + field),
		{ type: 'text' },
	);
	const cachedFields = Object.fromEntries(cachedFieldsMap);

	// Create object for field-label mappings
	const fields: Record<string, string> = {};

	// Initialize fields with cached values
	for (const [id, label] of Object.entries(cachedFields)) {
		fields[id.replace('field:', '')] = label || '';
	}

	// If field ID doesn't exist in KV then request from slack
	if (Object.keys(response.profile.fields || {}).filter((field) => !cachedFields['field:' + field]).length > 0) {
		console.log('Fetching fields from Slack');
		// Fetch team profile from slack
		const teamProfile = await context.client.team.profile.get();
		// Error handling
		if (teamProfile.error) {
			throw new Error(`Failed to get team profile: ${teamProfile.error}`);
		}
		const fieldsFromSlack = teamProfile.profile?.fields;
		for (const field of fieldsFromSlack || []) {
			if (field.id) {
				// Cache in KV
				await env.KV.put('field:' + field.id, field.label || '');
				// Set in object
				fields[field.id] = field.label || '';
			}
		}
	}

	// Remove unnecessary fields
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
