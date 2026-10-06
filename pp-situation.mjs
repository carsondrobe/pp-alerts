// Reading NHL.com's play-by-play for power plays. Kept apart from the watcher so it can be tested.

/**
 * Which side has the power play, from a play's situationCode: four digits for
 * away goalie, away skaters, home skaters, home goalie ("1451" = home 5 on 4).
 * A side with more skaters only because its goalie is pulled (a delayed penalty
 * or a late push, "0651") is not on a power play.
 */
export function advantage(situationCode) {
  if (!/^\d{4}$/.test(situationCode ?? "")) return null;
  const [awayGoalie, awaySkaters, homeSkaters, homeGoalie] = [...situationCode].map(Number);
  if (homeSkaters > awaySkaters && homeGoalie === 1) return { side: "home", skaters: `${homeSkaters} on ${awaySkaters}` };
  if (awaySkaters > homeSkaters && awayGoalie === 1) return { side: "away", skaters: `${awaySkaters} on ${homeSkaters}` };
  return null;
}

/** The power play in force after the game's latest play, if there is one, with the penalty that caused it. */
export function currentPowerPlay(game) {
  const plays = game.plays ?? [];
  const last = plays.at(-1);
  const edge = advantage(last?.situationCode);
  if (!last || !edge) return null;
  const team = edge.side === "home" ? game.homeTeam : game.awayTeam;
  const opponent = edge.side === "home" ? game.awayTeam : game.homeTeam;
  const penalty = plays.findLast((p) => p.typeDescKey === "penalty" && p.details?.eventOwnerTeamId === opponent.id);
  return {
    team: team.abbrev,
    teamName: team.commonName?.default ?? team.name?.default ?? team.abbrev,
    opponent: opponent.abbrev,
    skaters: edge.skaters,
    period: last.periodDescriptor?.number,
    timeRemaining: last.timeRemaining,
    penalty: penalty?.details?.descKey?.replaceAll("-", " "),
  };
}

/**
 * Every power play in a game, in order: one entry each time a side goes from
 * even (or short) to having the advantage. Used to replay finished games.
 */
export function powerPlays(game) {
  const starts = [];
  let side = null;
  (game.plays ?? []).forEach((play, i) => {
    const edge = advantage(play.situationCode);
    if (edge && edge.side !== side) starts.push(currentPowerPlay({ ...game, plays: game.plays.slice(0, i + 1) }));
    side = edge?.side ?? null;
  });
  return starts;
}
