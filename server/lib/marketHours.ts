/**
 * US equity market session helpers.
 *
 * Everything here is computed in `America/New_York` via `Intl`, not in server
 * local time. A Codespace runs UTC and a laptop runs whatever the user's
 * timezone is; deriving "is the market open" from `Date#getHours()` would give
 * a different answer on each, and would silently break twice a year at the DST
 * boundaries (which is exactly when a market-hours bug is hardest to spot).
 *
 * Known limitation: weekends are handled, **market holidays are not**. On
 * Thanksgiving or Christmas the session looks open and the sync will run,
 * pulling a quote that just repeats the prior close. That is harmless for the
 * data (the guard writes one snapshot and Finnhub returns the last close), but
 * the badge can read "stale" on a holiday because no fresh print arrives.
 * Wiring in a real exchange calendar is the fix if that ever matters.
 */

const MARKET_TZ = "America/New_York";

/** 09:30 ET, in minutes past midnight. */
const OPEN_MINUTES = 9 * 60 + 30;
/** 16:00 ET, in minutes past midnight. */
const CLOSE_MINUTES = 16 * 60;

/**
 * Slack added to the "expected next sync" when judging staleness. The
 * scheduler ticks hourly, so data can legitimately be up to an hour old plus
 * however long a full 45-ticker pass takes (~90s at the 2s throttle).
 */
const STALENESS_GRACE_MINUTES = 90;

/**
 * Minimum gap between two snapshots of the same ticker.
 *
 * Deliberately just under the hourly scheduler interval: at exactly 60 minutes
 * an hourly tick that fires a few hundred ms early would be skipped, and the
 * ticker would silently fall to a two-hour cadence.
 */
export const MIN_SNAPSHOT_INTERVAL_MS = 55 * 60 * 1000;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type EtParts = {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
  /** Minutes past midnight ET. */
  minutes: number;
};

function etParts(d: Date): EtParts {
  const parts = partsFormatter.formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";

  // Some ICU builds emit "24" for midnight under hour12:false.
  const hour = Number(get("hour")) % 24;

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/**
 * Offset to add to an ET wall-clock time (naively read as UTC) to get the real
 * UTC instant. +4h during EDT, +5h during EST.
 */
function etOffsetMsAt(d: Date): number {
  const p = etParts(d);
  const wallAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    Math.floor(p.minutes / 60),
    p.minutes % 60,
  );
  return d.getTime() - wallAsUtc;
}

/** The UTC instant for a given ET wall-clock date + minutes-past-midnight. */
function etWallClockToUtc(
  year: number,
  month: number,
  day: number,
  minutes: number,
): Date {
  const guess = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutes / 60),
    minutes % 60,
  );
  // Resolve the offset *at that instant* rather than at `now`, so a close
  // computed across a DST boundary lands on the right second.
  return new Date(guess + etOffsetMsAt(new Date(guess)));
}

/** True Mon–Fri between 09:30 and 16:00 ET. */
export function isMarketOpen(now: Date = new Date()): boolean {
  const p = etParts(now);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.minutes >= OPEN_MINUTES && p.minutes < CLOSE_MINUTES;
}

/** The most recent weekday 16:00 ET at or before `now`. */
export function lastMarketClose(now: Date = new Date()): Date {
  const p = etParts(now);
  // Calendar cursor held at UTC midnight purely for Y/M/D arithmetic — the
  // time component is never read, only the date and day-of-week.
  const cursor = new Date(Date.UTC(p.year, p.month - 1, p.day));

  for (let i = 0; i < 10; i++) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const close = etWallClockToUtc(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        cursor.getUTCDate(),
        CLOSE_MINUTES,
      );
      if (close.getTime() <= now.getTime()) return close;
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  // Unreachable in practice (10 days always spans a weekday), but a sane
  // floor beats returning null and forcing null-handling on every caller.
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

/**
 * How old the market data may get before the dashboard badge should go red,
 * expressed from `now`.
 *
 * The threshold has to track the market, not the clock. While the session is
 * open we expect a fresh print every hour. Once it closes, the newest data
 * that *can* exist is the closing print — so overnight and across a weekend
 * the allowance grows with the time since that close. Without this, a badge
 * with a fixed 60-minute threshold is red every evening and all weekend for
 * data that is perfectly current.
 */
export function staleAfterMinutes(now: Date = new Date()): number {
  const sinceCloseMinutes = Math.round(
    Math.max(0, now.getTime() - lastMarketClose(now).getTime()) / 60_000,
  );
  const allowLastClose = sinceCloseMinutes + STALENESS_GRACE_MINUTES;

  if (!isMarketOpen(now)) return allowLastClose;

  // The session is open, but the scheduler ticks hourly on an arbitrary phase,
  // so the first intraday print may not have landed yet. For the first 90
  // minutes after the open, holding only the previous close is still fine —
  // otherwise the badge would go red every single morning between the opening
  // bell and whenever the hour happens to turn over.
  const minutesSinceOpen = etParts(now).minutes - OPEN_MINUTES;
  if (minutesSinceOpen < STALENESS_GRACE_MINUTES) return allowLastClose;

  // Well into the session: we should be holding an intraday print.
  return STALENESS_GRACE_MINUTES;
}

/**
 * Whether a ticker is due for a new snapshot.
 *
 * Replaces the old same-day guard. The rules, in order:
 *
 *  1. Never synced → sync.
 *  2. Newest snapshot predates the last close → sync. This is what captures
 *     the closing print (the 15:30 tick is stale once 16:00 passes) and what
 *     catches up after downtime — a weekend, a holiday, or a laptop that was
 *     shut.
 *  3. Market closed and we already hold that close → skip. Prices do not move,
 *     so hourly rows overnight would be identical noise.
 *  4. Market open → refresh at most once an hour.
 */
export function shouldSyncTicker(
  newestSnapshotAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!newestSnapshotAt) return true;
  if (newestSnapshotAt.getTime() < lastMarketClose(now).getTime()) return true;
  if (!isMarketOpen(now)) return false;
  return now.getTime() - newestSnapshotAt.getTime() >= MIN_SNAPSHOT_INTERVAL_MS;
}
