# Power-play alerts

Sends a Telegram message each time an NHL team with one of your fantasy skaters goes on the power play:

> 🏒 **Power play: Lightning**
> Kucherov (PP1)
> PHI at TBL · 1st, 14:25 left · tripping

It runs on GitHub Actions, so nothing of yours has to be switched on.

## How it works

- Each run asks your hosted Hockey Companion for your skaters by NHL team, with each one's power-play unit. Nothing about your team is stored in this repository, and the run log only says how many games it is watching.
- `.github/workflows/pp-alerts.yml` starts a run every half hour during the hours games are played. A run with no game of yours on leaves within seconds; the one that finds a game stays and checks NHL.com's public play-by-play every 15 seconds.
- `pp-situation.mjs` reads the manpower on the ice from each play. A power play is one side having more skaters with its own goalie in net; an extra skater for a pulled goalie doesn't count.
- Alerts skip the other team's power plays and players known to be off the power play.

## Setup

1. In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts.
2. Put the token in the app's `.env.local` as `TELEGRAM_BOT_TOKEN=...`, send your bot any message, and run `npm run pp:setup` in the app folder. It saves `TELEGRAM_CHAT_ID` and sends a sample alert.
3. Give this repository its secrets: in the app folder, run `npm run pp:secrets`. It copies the Telegram token, your chat id and the watcher's key from `.env.local` to this repository's Actions secrets. (`WATCHLIST_URL`, the hosted app's address followed by `/api/watchlist`, is set separately with `gh secret set WATCHLIST_URL`.)

## Checking on it

- `gh run list --workflow pp-alerts.yml` shows recent runs; `gh run view --log <id>` shows what one saw.
- `gh workflow run pp-alerts.yml` starts a run now.
- `node pp-watch.mjs --replay <NHL game id>` prints the alerts a finished game would have sent.

## Limits

- An alert lands roughly 15 to 40 seconds after the penalty: NHL.com's feed runs a little behind the game, and the watcher checks every 15 seconds.
- GitHub starts scheduled runs late when it is busy, sometimes by 15 minutes or more. Runs start early enough to absorb that, but a game's first minutes can occasionally be missed.
- GitHub pauses schedules in a repository with no activity for 60 days. Roster updates from the app count as activity.
- If the hosted app is down or ESPN has expired your cookies, a run can't read your roster and sends nothing until that's fixed.
