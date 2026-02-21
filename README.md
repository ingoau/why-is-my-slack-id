# Why is my Slack ID?
A slack bot that explains why a user has a specific Slack ID, using AI to make far-fetched conclusions based on profile fields.

## Tech stack
* Cloudflare Workers
* Cloudflare KV
* Typescript
* Openrouter (uses Cerebras and Groq)
* Vercel AI SDK
* slack-cloudflare-workers

## Running
1. Deploy to Cloudflare Workers
2. Bind KV namespace to Cloudflare Workers
3. Get an openrouter api key
4. Create a slack bot [here](https://api.slack.com/apps) and get a bot ID. It needs the conversations.history scope.
5. Set ENV vars
```
CHANNEL_ID=
OPENROUTER_API_KEY=
SLACK_BOT_TOKEN=
SLACK_LOGGING_LEVEL=
SLACK_SIGNING_SECRET=
```
6. Set up Slack event subscriptions with the URL `https://<YOUR_WORKER_URL>/slack/events`
