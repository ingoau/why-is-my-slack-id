/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/slack/events' && request.method === 'POST') {
			const body = (await request.json()) as unknown;
			if (typeof body === 'object' && body !== null && 'type' in body && body.type === 'url_verification') {
				if ('challenge' in body) {
					return new Response(String(body.challenge));
				}
			}
			return new Response('Test');
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
