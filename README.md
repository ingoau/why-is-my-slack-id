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

Send `opt out` in the channel to stop anyone from running the bot on you, and `opt in` to undo. You can also opt out a bot with `opt out @bot`. Opt-outs live in memory, so they reset when the bot restarts.

## Running

1. Populate env
2. `docker compose up -d`
