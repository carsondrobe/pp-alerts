import { describe, expect, it } from "vitest";
import { advantage, currentPowerPlay, powerPlays } from "./pp-situation.mjs";

describe("advantage", () => {
  it("reads which side has more skaters", () => {
    expect(advantage("1451")).toEqual({ side: "home", skaters: "5 on 4" });
    expect(advantage("1541")).toEqual({ side: "away", skaters: "5 on 4" });
    expect(advantage("1351")).toEqual({ side: "home", skaters: "5 on 3" });
  });

  it("is nothing at even strength, four on four included", () => {
    expect(advantage("1551")).toBeNull();
    expect(advantage("1441")).toBeNull();
  });

  it("doesn't mistake a pulled goalie for a power play", () => {
    // Seen in PHI at TBL, 2026-10-05: the away side had six skaters on a delayed penalty.
    expect(advantage("0651")).toBeNull();
    expect(advantage("1560")).toBeNull();
  });

  it("ignores a missing or malformed code", () => {
    expect(advantage(undefined)).toBeNull();
    expect(advantage("15")).toBeNull();
  });
});

// The shape of NHL.com's play-by-play, cut down to what the watcher reads.
const play = (situationCode, extra = {}) => ({
  situationCode,
  periodDescriptor: { number: 1 },
  timeRemaining: "14:25",
  typeDescKey: "faceoff",
  ...extra,
});
const game = (plays) => ({
  awayTeam: { id: 4, abbrev: "PHI", commonName: { default: "Flyers" } },
  homeTeam: { id: 14, abbrev: "TBL", commonName: { default: "Lightning" } },
  plays,
});
const tripping = play("1551", { typeDescKey: "penalty", details: { descKey: "tripping", eventOwnerTeamId: 4 } });

describe("currentPowerPlay", () => {
  it("names the team on the power play and the penalty that put it there", () => {
    expect(currentPowerPlay(game([play("1551"), tripping, play("1451")]))).toEqual({
      team: "TBL",
      teamName: "Lightning",
      opponent: "PHI",
      skaters: "5 on 4",
      period: 1,
      timeRemaining: "14:25",
      penalty: "tripping",
    });
  });

  it("is nothing once the teams are back to even", () => {
    expect(currentPowerPlay(game([tripping, play("1451"), play("1551")]))).toBeNull();
  });
});

describe("powerPlays", () => {
  it("counts each power play once, however many plays happen during it", () => {
    const plays = [play("1551"), tripping, play("1451"), play("1451"), play("1551"), play("1541"), play("1541"), play("1551")];
    expect(powerPlays(game(plays)).map((p) => p.team)).toEqual(["TBL", "PHI"]);
  });
});
