# Why is my Slack ID

A Slack bot that explains why a user has a specific Slack ID, using an AI agent to make far-fetched conclusions based on profile fields and information it can find about the user online.

## Stack

- Node.js
- Cursor SDK
- OpenRouter SDK
- Typescript
- Slack Bolt
- T3 Env + Zod

## Testing

If you're in the [Hack Club Slack](https://slack.hackclub.com/) you can join the [#why-is-my-slack-id](https://hackclub.enterprise.slack.com/archives/C0AF8SA49J8) channel and send a message. Wait like two minutes for a response explaining your Slack ID.

## Opting out

Send `opt out` in the channel to stop anyone from running the bot on you, and `opt in` to undo. You can also opt out a bot with `opt out @bot`. Opt-outs persist in the JSON file configured by `OPT_OUTS_FILE` (`/data/opt-outs.json` by default). The included Docker Compose file mounts `/data` as a named volume, so they survive container restarts and replacements.

Replying `delete` in a thread removes the bot's analysis from that thread, but only when the person the analysis is about has opted out. The bot remembers which of its messages analyzed whom in the JSON file configured by `ANALYSES_FILE` (`/data/analyses.json` by default), so this keeps working across restarts; only analyses recorded after this change can be deleted this way.

## Running

1. Populate env
2. `docker compose up -d`
