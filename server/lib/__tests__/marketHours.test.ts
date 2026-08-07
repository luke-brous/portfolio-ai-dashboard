import { it, expect, describe } from "bun:test";
import {
  MIN_SNAPSHOT_INTERVAL_MS,
  isMarketOpen,
  lastMarketClose,
  shouldSyncTicker,
  staleAfterMinutes,
} from "../marketHours";

/**
 * All fixtures are written as UTC instants with the intended ET wall-clock in
 * the test name. Two regimes are covered deliberately:
 *
 *   - August 2026 → EDT (UTC-4), so 09:30 ET = 13:30Z
 *   - January 2026 → EST (UTC-5), so 09:30 ET = 14:30Z
 *
 * If the implementation ever regresses to server-local time these split
 * immediately, which is the whole point — a Codespace runs UTC and would
 * otherwise look "correct" while being 4 hours out.
 */

describe("isMarketOpen", () => {
  describe("during EDT (summer, UTC-4)", () => {
    it("is closed one minute before the 09:30 ET open", () => {
      expect(isMarketOpen(new Date("2026-08-05T13:29:00Z"))).toBe(false);
    });

    it("is open exactly at the 09:30 ET open", () => {
      expect(isMarketOpen(new Date("2026-08-05T13:30:00Z"))).toBe(true);
    });

    it("is open at midday ET", () => {
      expect(isMarketOpen(new Date("2026-08-05T16:00:00Z"))).toBe(true);
    });

    it("is open one minute before the 16:00 ET close", () => {
      expect(isMarketOpen(new Date("2026-08-05T19:59:00Z"))).toBe(true);
    });

    it("is closed exactly at the 16:00 ET close", () => {
      expect(isMarketOpen(new Date("2026-08-05T20:00:00Z"))).toBe(false);
    });
  });

  describe("during EST (winter, UTC-5)", () => {
    it("is closed one minute before the 09:30 ET open", () => {
      expect(isMarketOpen(new Date("2026-01-07T14:29:00Z"))).toBe(false);
    });

    it("is open exactly at the 09:30 ET open", () => {
      expect(isMarketOpen(new Date("2026-01-07T14:30:00Z"))).toBe(true);
    });

    it("is open one minute before the 16:00 ET close", () => {
      expect(isMarketOpen(new Date("2026-01-07T20:59:00Z"))).toBe(true);
    });

    it("is closed exactly at the 16:00 ET close", () => {
      expect(isMarketOpen(new Date("2026-01-07T21:00:00Z"))).toBe(false);
    });
  });

  describe("weekends", () => {
    it("is closed on Saturday midday", () => {
      expect(isMarketOpen(new Date("2026-08-08T16:00:00Z"))).toBe(false);
    });

    it("is closed on Sunday midday", () => {
      expect(isMarketOpen(new Date("2026-08-09T16:00:00Z"))).toBe(false);
    });
  });
});

describe("lastMarketClose", () => {
  it("returns the previous session's close while today's is still running", () => {
    // Wed 10:00 ET — Wednesday's close has not happened yet.
    const close = lastMarketClose(new Date("2026-08-05T14:00:00Z"));
    expect(close.toISOString()).toBe("2026-08-04T20:00:00.000Z"); // Tue 16:00 ET
  });

  it("returns today's close once the session has ended", () => {
    const close = lastMarketClose(new Date("2026-08-05T20:30:00Z")); // Wed 16:30 ET
    expect(close.toISOString()).toBe("2026-08-05T20:00:00.000Z");
  });

  it("skips back over the weekend from Sunday", () => {
    const close = lastMarketClose(new Date("2026-08-09T16:00:00Z")); // Sun 12:00 ET
    expect(close.toISOString()).toBe("2026-08-07T20:00:00.000Z"); // Fri 16:00 ET
  });

  it("skips back over the weekend from Monday pre-open", () => {
    const close = lastMarketClose(new Date("2026-08-10T12:00:00Z")); // Mon 08:00 ET
    expect(close.toISOString()).toBe("2026-08-07T20:00:00.000Z"); // Fri 16:00 ET
  });

  it("resolves the close at the correct UTC offset in winter", () => {
    const close = lastMarketClose(new Date("2026-01-07T15:00:00Z")); // Wed 10:00 ET
    // 16:00 EST = 21:00Z, not 20:00Z — this is the DST regression guard.
    expect(close.toISOString()).toBe("2026-01-06T21:00:00.000Z");
  });
});

describe("staleAfterMinutes", () => {
  it("is the flat grace period while the market is open", () => {
    expect(staleAfterMinutes(new Date("2026-08-05T16:00:00Z"))).toBe(90);
  });

  it("grows with time since the close once the session ends", () => {
    // Wed 16:30 ET — 30 minutes past the close, plus 90 grace.
    expect(staleAfterMinutes(new Date("2026-08-05T20:30:00Z"))).toBe(120);
  });

  it("covers an entire overnight gap so pre-open data is not called stale", () => {
    // Thu 09:00 ET: last close was Wed 16:00 ET, 17h earlier.
    const threshold = staleAfterMinutes(new Date("2026-08-06T13:00:00Z"));
    expect(threshold).toBe(17 * 60 + 90);
  });

  it("covers a full weekend", () => {
    // Sun 12:00 ET: last close was Fri 16:00 ET, 44h earlier.
    const threshold = staleAfterMinutes(new Date("2026-08-09T16:00:00Z"));
    expect(threshold).toBe(44 * 60 + 90);
  });

  it("tolerates holding only the previous close while the market is shut", () => {
    // Whenever the market is closed, the newest data that *can* exist is the
    // last close — so holding exactly that must never read as stale.
    for (const iso of [
      "2026-08-05T20:30:00Z", // Wed after close
      "2026-08-06T13:00:00Z", // Thu pre-open
      "2026-08-09T16:00:00Z", // Sun midday
      "2026-08-10T12:00:00Z", // Mon pre-open
    ]) {
      const now = new Date(iso);
      expect(isMarketOpen(now)).toBe(false);
      const ageOfCloseMinutes =
        (now.getTime() - lastMarketClose(now).getTime()) / 60_000;
      expect(staleAfterMinutes(now)).toBeGreaterThan(ageOfCloseMinutes);
    }
  });

  it("still tolerates the previous close in the first 90 minutes of a session", () => {
    // The scheduler ticks hourly on an arbitrary phase, so at 10:00 ET the
    // first intraday print may legitimately not have arrived. Without this
    // grace the badge would go red every morning right after the open.
    const now = new Date("2026-08-05T14:00:00Z"); // Wed 10:00 ET, 30 min in
    expect(isMarketOpen(now)).toBe(true);
    const ageOfCloseMinutes =
      (now.getTime() - lastMarketClose(now).getTime()) / 60_000;
    expect(staleAfterMinutes(now)).toBeGreaterThan(ageOfCloseMinutes);
  });

  it("expects an intraday print once the session is well under way", () => {
    // By midday, holding only yesterday's close is a genuine fault and the
    // badge should say so.
    const now = new Date("2026-08-05T16:00:00Z"); // Wed 12:00 ET, 150 min in
    const ageOfCloseMinutes =
      (now.getTime() - lastMarketClose(now).getTime()) / 60_000;
    expect(staleAfterMinutes(now)).toBe(90);
    expect(staleAfterMinutes(now)).toBeLessThan(ageOfCloseMinutes);
  });
});

describe("shouldSyncTicker", () => {
  const wedMidSession = new Date("2026-08-05T16:00:00Z"); // Wed 12:00 ET
  const wedAfterClose = new Date("2026-08-05T20:30:00Z"); // Wed 16:30 ET
  const sunMidday = new Date("2026-08-09T16:00:00Z"); // Sun 12:00 ET

  it("syncs a ticker that has never been snapshotted", () => {
    expect(shouldSyncTicker(null, wedMidSession)).toBe(true);
  });

  it("skips a ticker refreshed within the hour during the session", () => {
    const newest = new Date(wedMidSession.getTime() - 25 * 60_000);
    expect(shouldSyncTicker(newest, wedMidSession)).toBe(false);
  });

  it("syncs a ticker last refreshed over an hour ago during the session", () => {
    const newest = new Date(wedMidSession.getTime() - 85 * 60_000);
    expect(shouldSyncTicker(newest, wedMidSession)).toBe(true);
  });

  it("uses a window just under an hour so hourly ticks are never skipped", () => {
    // A tick arriving a few seconds early must still pass the guard,
    // otherwise the effective cadence silently halves to two hours.
    const newest = new Date(wedMidSession.getTime() - 59 * 60_000);
    expect(shouldSyncTicker(newest, wedMidSession)).toBe(true);
    expect(MIN_SNAPSHOT_INTERVAL_MS).toBeLessThan(60 * 60 * 1000);
  });

  it("syncs once after the close to capture the closing print", () => {
    // Last snapshot 15:35 ET, now 16:30 ET — the close has happened since.
    const newest = new Date("2026-08-05T19:35:00Z");
    expect(shouldSyncTicker(newest, wedAfterClose)).toBe(true);
  });

  it("stops syncing once the closing print is held", () => {
    const newest = new Date("2026-08-05T20:31:00Z"); // 16:31 ET, after close
    expect(shouldSyncTicker(newest, new Date("2026-08-05T21:30:00Z"))).toBe(
      false,
    );
  });

  it("stays quiet all weekend when Friday's close is held", () => {
    const newest = new Date("2026-08-07T20:05:00Z"); // Fri 16:05 ET
    expect(shouldSyncTicker(newest, sunMidday)).toBe(false);
  });

  it("catches up at the weekend if Friday's session was missed", () => {
    // This is the downtime case: the machine was off on Friday, so the
    // newest data is Thursday's and Friday's close was never captured.
    const newest = new Date("2026-08-06T20:05:00Z"); // Thu 16:05 ET
    expect(shouldSyncTicker(newest, sunMidday)).toBe(true);
  });

  it("does not write overnight rows for data already past the close", () => {
    const newest = new Date("2026-08-05T20:05:00Z"); // Wed 16:05 ET
    // 22:00 ET the same evening — prices are not moving.
    expect(shouldSyncTicker(newest, new Date("2026-08-06T02:00:00Z"))).toBe(
      false,
    );
  });
});
