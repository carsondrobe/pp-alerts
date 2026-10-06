// Power-play alerts: a Telegram message each time an NHL team with one of your
// skaters goes on the power play.
//
// It runs in the cloud, on GitHub Actions (.github/workflows/pp-alerts.yml), so no
// computer of yours has to be on. This folder is its own small repository and holds
// only the watcher: your roster is read from your hosted Hockey Companion each time
// it runs, so nothing about your team is stored here.
//
//   node pp-watch.mjs            watch tonight's games and send alerts
//   node pp-watch.mjs --setup    find your Telegram chat and send a sample alert
//   node pp-watch.mjs --test     send a sample alert
//   node pp-watch.mjs --replay <game id>   show the alerts a finished game would have sent
//
// Settings (secrets in the cloud, the app's .env.local on your own machine):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   where alerts go
//   WATCHLIST_URL, WATCHLIST_KEY           your hosted app's /api/watchlist and its key
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { currentPowerPlay, powerPlays } from "./pp-situation.mjs";

const NHL = "https://api-web.nhle.com/v1";
const TELEGRAM = "https://api.telegram.org";
/** On your own machine the settings live in the app's .env.local; in the cloud they're secrets. */
const ENV_FILE = new URL("../.env.local", import.meta.url);

/** NHL.com posts plays a few seconds after they happen; checking faster than this gains nothing. */
const LIVE_POLL_MS = 15_000;
/** Before puck drop: how often to look again. */
const IDLE_POLL_MS = 60_000;
/**
 * A run starts every half hour (see the workflow). One that finds no game of yours
 * starting within this window leaves, and a later run picks the game up.
 */
const LOOKAHEAD_MS = 75 * 60_000;
/** GitHub stops a job at 6 hours. Leave before that so the next queued run takes over cleanly. */
const MAX_RUN_MS = 5.5 * 3600_000;
/** The hour of the day's first scheduled runs (see the workflow): when a broken setup gets reported. */
const FIRST_RUN_HOUR_UTC = 16;
const LIVE = new Set(["LIVE", "CRIT"]);
const OVER = new Set(["FINAL", "OFF"]);

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, timeoutMs = 20_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} returned ${res.status}`);
  return res.json();
}

function setting(name) {
  if (process.env[name]) return process.env[name];
  if (!existsSync(ENV_FILE)) return undefined;
  return readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${name}=["']?([^"'\\s]+)["']?\\s*$`, "m"))?.[1];
}

/** Calls the Telegram Bot API. Errors never include the URL, which contains the bot's token. */
async function telegram(method, body) {
  const token = setting("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN isn't set");
  let res;
  try {
    res = await fetch(`${TELEGRAM}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    throw new Error(`Telegram unreachable (${error.name})`);
  }
  const reply = await res.json().catch(() => ({}));
  if (!reply.ok) throw new Error(`Telegram refused ${method}: ${reply.description ?? res.status}`);
  return reply.result;
}

const escapeHtml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function notify(alert) {
  const chat = setting("TELEGRAM_CHAT_ID");
  if (!chat) throw new Error("TELEGRAM_CHAT_ID isn't set");
  await telegram("sendMessage", {
    chat_id: chat,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    text: [
      `🏒 <b>${escapeHtml(alert.title)}</b>`,
      alert.subtitle && escapeHtml(alert.subtitle),
      alert.link ? `<a href="${alert.link}">${escapeHtml(alert.message)}</a>` : escapeHtml(alert.message),
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

/** Your skaters by NHL team, with power-play units, from your hosted app. */
async function loadWatchlist() {
  const url = setting("WATCHLIST_URL");
  if (!url) throw new Error("WATCHLIST_URL isn't set");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${setting("WATCHLIST_KEY") ?? ""}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`The app refused the roster request (${res.status}).`);
  return (await res.json()).teams ?? {};
}

/** "Kucherov (PP1), Point (PP2)"; players known to be off the power play are left out. */
function describe(players) {
  return players
    .filter((p) => p.unit !== null)
    .sort((a, b) => (a.unit ?? 3) - (b.unit ?? 3))
    .map((p) => `${p.name.split(" ").slice(1).join(" ") || p.name}${p.unit ? ` (PP${p.unit})` : ""}`)
    .join(", ");
}

const ordinal = (n) => (n > 3 ? "OT" : `${n}${["st", "nd", "rd"][n - 1]}`);

function alertFor(powerPlay, players, game) {
  return {
    title: `Power play: ${powerPlay.teamName}`,
    subtitle: describe(players),
    message: [
      `${game.awayTeam.abbrev} at ${game.homeTeam.abbrev}`,
      powerPlay.period && `${ordinal(powerPlay.period)}, ${powerPlay.timeRemaining} left`,
      powerPlay.skaters !== "5 on 4" && powerPlay.skaters,
      powerPlay.penalty,
    ]
      .filter(Boolean)
      .join(" · "),
    link: `https://www.nhl.com/gamecenter/${game.id}`,
  };
}

const SETTINGS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "WATCHLIST_URL", "WATCHLIST_KEY"];

async function watch() {
  // Until setup is finished there is nothing to do, and a failed run every half hour would only be noise.
  const missing = SETTINGS.filter((name) => !setting(name));
  if (missing.length > 0) return log(`Not set up yet. Still needed: ${missing.join(", ")}.`);

  let teams;
  try {
    teams = await loadWatchlist();
  } catch (error) {
    log(`Roster unavailable: ${error.message}`);
    // Worth knowing about (usually ESPN has expired your cookies), but only once a day, not every run.
    if (new Date().getUTCHours() === FIRST_RUN_HOUR_UTC) {
      await notify({
        title: "Power-play alerts are off",
        subtitle: "I couldn't read your roster from Hockey Companion.",
        message: `${error.message} Open the app to check it; ESPN may have expired your cookies.`,
      }).catch(() => {});
    }
    return;
  }
  // A team only counts if at least one of your skaters there isn't known to be off the power play.
  const watched = new Map(Object.entries(teams).filter(([, players]) => describe(players)));
  if (watched.size === 0) return log("Your roster came back empty.");

  // game id -> team on the power play when last seen. A game is only compared once it has
  // been seen, so a run that starts mid-power-play doesn't repeat an alert the last run sent.
  const onPowerPlay = new Map();
  const started = Date.now();
  let announced = false;
  while (Date.now() - started < MAX_RUN_MS) {
    let games;
    try {
      games = (await getJson(`${NHL}/score/now`)).games ?? [];
    } catch (error) {
      log(`Scoreboard unavailable: ${error.message}`);
      await sleep(LIVE_POLL_MS);
      continue;
    }
    const pending = games.filter(
      (g) => (watched.has(g.homeTeam.abbrev) || watched.has(g.awayTeam.abbrev)) && !OVER.has(g.gameState),
    );
    const live = pending.filter((g) => LIVE.has(g.gameState));
    const soon = pending.filter((g) => Date.parse(g.startTimeUTC) - Date.now() < LOOKAHEAD_MS);
    if (live.length === 0 && soon.length === 0) {
      return log(pending.length ? "Nothing of yours starts for a while. A later run will pick it up." : "No games left for your players.");
    }
    if (!announced) {
      // This log is public: counts only, nothing that names your players or their teams.
      log(`Watching ${pending.length} game${pending.length === 1 ? "" : "s"}.`);
      announced = true;
    }

    for (const game of live) {
      try {
        const powerPlay = currentPowerPlay(await getJson(`${NHL}/gamecenter/${game.id}/play-by-play`));
        const seen = onPowerPlay.has(game.id);
        const before = onPowerPlay.get(game.id);
        onPowerPlay.set(game.id, powerPlay?.team);
        if (seen && powerPlay && powerPlay.team !== before && watched.has(powerPlay.team)) {
          const alert = alertFor(powerPlay, watched.get(powerPlay.team), game);
          await notify(alert).then(
            () => log("Alert sent."),
            (error) => log(`Alert not sent: ${error.message}`),
          );
        }
      } catch (error) {
        log(`Game ${game.id} unavailable: ${error.message}`);
      }
    }
    await sleep(live.length > 0 ? LIVE_POLL_MS : IDLE_POLL_MS);
  }
  log("Handing over to the next run.");
}

/** Print the power plays the watcher would have alerted on in a finished game. */
async function replay(gameId) {
  const game = await getJson(`${NHL}/gamecenter/${gameId}/play-by-play`);
  const teams = await loadWatchlist();
  console.log(`${game.awayTeam.abbrev} at ${game.homeTeam.abbrev}, ${game.gameDate}`);
  for (const powerPlay of powerPlays(game)) {
    const players = teams[powerPlay.team];
    const alert = alertFor(powerPlay, players ?? [], game);
    console.log(`${players && describe(players) ? "ALERT " : "quiet "} ${alert.title} · ${alert.subtitle || "none of yours"} · ${alert.message}`);
  }
}

/** Find the chat to send alerts to (message your bot once first), save it, and send a sample. */
async function setup() {
  const bot = await telegram("getMe");
  console.log(`Bot: @${bot.username}`);
  if (!setting("TELEGRAM_CHAT_ID")) {
    const updates = await telegram("getUpdates", { allowed_updates: ["message"] });
    const chats = new Map(updates.flatMap((u) => (u.message?.chat ? [[u.message.chat.id, u.message.chat]] : [])));
    if (chats.size === 0) {
      return console.log(`No messages yet. Open Telegram, send any message to @${bot.username}, then run this again.`);
    }
    if (chats.size > 1) {
      console.log("More than one chat has messaged this bot. Add the right one to .env.local as TELEGRAM_CHAT_ID=<id>:");
      for (const chat of chats.values()) console.log(`  ${chat.id}  ${chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ")}`);
      return;
    }
    const [chat] = chats.values();
    appendFileSync(ENV_FILE, `\nTELEGRAM_CHAT_ID=${chat.id}\n`);
    console.log(`Saved your chat (${chat.first_name ?? chat.title}) to .env.local.`);
  }
  await sample();
}

async function sample() {
  await notify({
    title: "Power play: Lightning",
    subtitle: "Kucherov (PP1)",
    message: "TBL at NYR · 2nd, 12:34 left · tripping",
    link: "https://www.nhl.com/scores",
  });
  console.log("Sent a sample alert to Telegram.");
}

const [mode, argument] = process.argv.slice(2);
try {
  if (mode === "--test") await sample();
  else if (mode === "--setup") await setup();
  else if (mode === "--replay") await replay(argument);
  else await watch();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
