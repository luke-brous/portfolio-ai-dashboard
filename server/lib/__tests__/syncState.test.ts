import { it, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  __setSyncRunStoreForTests,
  getLastRun,
  getLastRunPersisted,
  getSyncFreshness,
  getSyncSnapshot,
  isSyncInFlight,
  recordSyncFinish,
  recordSyncRun,
  recordSyncStart,
  resetSyncStateForTesting,
  type SyncRun,
  type SyncRunStore,
} from "./../syncState";

/**
 * In-memory stand-in for the `sync_runs` table.
 *
 * Installed through the store seam rather than `mock.module("../db/client")`
 * because Bun's module mocks are process-global and permanent — see the
 * Testing Strategy section of CLAUDE.md. This keeps these unit tests from
 * opening (or writing to) the real SQLite file.
 */
function makeFakeStore() {
  const rows: SyncRun[] = [];
  let lastDataAt: Date | null = null;
  let failOnInsert = false;
  let failOnRead = false;

  const store: SyncRunStore = {
    insertSyncRun(run) {
      if (failOnInsert) throw new Error("disk is on fire");
      rows.push(run);
    },
    selectLatestSyncRun() {
      if (failOnRead) throw new Error("table is missing");
      if (rows.length === 0) return null;
      return rows.reduce((newest, r) =>
        r.at.getTime() >= newest.at.getTime() ? r : newest,
      );
    },
    selectLastDataAt() {
      if (failOnRead) throw new Error("table is missing");
      return lastDataAt;
    },
  };

  return {
    store,
    rows,
    setLastDataAt(d: Date | null) {
      lastDataAt = d;
    },
    failInserts() {
      failOnInsert = true;
    },
    failReads() {
      failOnRead = true;
    },
  };
}

describe("Sync State Utilities", () => {
  let fake: ReturnType<typeof makeFakeStore>;

  beforeEach(() => {
    resetSyncStateForTesting();
    fake = makeFakeStore();
    __setSyncRunStoreForTests(fake.store);
  });

  // Module state is shared across the whole test process — hand the real
  // SQLite store back so a later suite does not inherit this fake.
  afterAll(() => {
    __setSyncRunStoreForTests(null);
  });

  it("should return null for last run at startup", () => {
    expect(getLastRun()).toBeNull();
  });

  it("should update last run after recording a successful sync", () => {
    const runOutcome = { at: new Date(), ok: true, note: "Success" };
    recordSyncRun(runOutcome);
    expect(getLastRun()).toEqual(runOutcome);
  });

  it("should update last run after recording a failed sync", () => {
    const runOutcome = { at: new Date(), ok: false, note: "Error message" };
    recordSyncRun(runOutcome);
    expect(getLastRun()).toEqual(runOutcome);
    expect(getLastRun()?.ok).toBe(false);
    expect(getLastRun()?.note).toBe("Error message");
  });

  it("should toggle in-flight status correctly", () => {
    expect(isSyncInFlight()).toBe(false);
    recordSyncStart();
    expect(isSyncInFlight()).toBe(true);
    recordSyncFinish();
    expect(isSyncInFlight()).toBe(false);
  });

  it("should keep in-flight status true after two consecutive starts", () => {
    recordSyncStart();
    recordSyncStart();
    expect(isSyncInFlight()).toBe(true);
    recordSyncFinish();
    expect(isSyncInFlight()).toBe(false);
  });

  it("should return the correct snapshot", () => {
    const runOutcome = { at: new Date(), ok: true, note: "Snapshot test" };
    recordSyncStart();
    recordSyncRun(runOutcome);

    const snapshot = getSyncSnapshot();
    expect(snapshot).toEqual({ lastRun: runOutcome, inFlight: true });

    recordSyncFinish();
    expect(getSyncSnapshot()).toEqual({ lastRun: runOutcome, inFlight: false });
  });

  describe("persistence", () => {
    it("writes a row when a run is recorded", () => {
      const outcome = {
        at: new Date("2026-08-07T10:00:00.000Z"),
        ok: true,
        note: "45 ticker(s) ok",
        tickersProcessed: 45,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
      recordSyncRun(outcome);
      expect(fake.rows).toEqual([outcome]);
    });

    it("returns the persisted row after a simulated restart", () => {
      const outcome = {
        at: new Date("2026-08-07T10:00:00.000Z"),
        ok: true,
        note: "45 ticker(s) ok",
      };
      recordSyncRun(outcome);

      // Dropping the in-memory cache is what a process restart does; the
      // row in sync_runs is the whole point of the feature.
      resetSyncStateForTesting();
      expect(getLastRun()).toBeNull();
      expect(getLastRunPersisted()).toEqual(outcome);
    });

    it("prefers the in-memory value over the persisted one", () => {
      const older = {
        at: new Date("2026-08-07T09:00:00.000Z"),
        ok: true,
        note: "older",
      };
      const newer = {
        at: new Date("2026-08-07T10:00:00.000Z"),
        ok: true,
        note: "newer",
      };
      fake.store.insertSyncRun(older);
      recordSyncRun(newer);
      expect(getLastRunPersisted()).toEqual(newer);
    });

    it("returns the newest persisted row when several exist", () => {
      fake.store.insertSyncRun({
        at: new Date("2026-08-07T08:00:00.000Z"),
        ok: true,
        note: "first",
      });
      fake.store.insertSyncRun({
        at: new Date("2026-08-07T12:00:00.000Z"),
        ok: false,
        note: "latest",
      });
      fake.store.insertSyncRun({
        at: new Date("2026-08-07T10:00:00.000Z"),
        ok: true,
        note: "middle",
      });
      expect(getLastRunPersisted()?.note).toBe("latest");
    });

    it("does not throw when the insert fails, and still caches in memory", () => {
      fake.failInserts();
      const outcome = { at: new Date(), ok: true, note: "Success" };
      expect(() => recordSyncRun(outcome)).not.toThrow();
      // A failing logging table must not cost us the live status.
      expect(getLastRun()).toEqual(outcome);
    });

    it("does not throw when the persisted read fails", () => {
      fake.failReads();
      resetSyncStateForTesting();
      expect(() => getLastRunPersisted()).not.toThrow();
      expect(getLastRunPersisted()).toBeNull();
    });
  });

  describe("getSyncFreshness", () => {
    it("reports lastDataAt alongside the run and in-flight flag", () => {
      const outcome = {
        at: new Date("2026-08-07T10:00:00.000Z"),
        ok: true,
        note: "45 ticker(s) ok",
      };
      const dataAt = new Date("2026-08-07T09:59:00.000Z");
      recordSyncRun(outcome);
      fake.setLastDataAt(dataAt);

      expect(getSyncFreshness()).toEqual({
        lastRun: outcome,
        lastDataAt: dataAt,
        inFlight: false,
      });
    });

    it("falls back to the persisted run after a restart", () => {
      const outcome = {
        at: new Date("2026-08-07T10:00:00.000Z"),
        ok: true,
        note: "persisted",
      };
      recordSyncRun(outcome);
      resetSyncStateForTesting();

      const freshness = getSyncFreshness();
      expect(freshness.lastRun).toEqual(outcome);
      expect(freshness.inFlight).toBe(false);
    });

    it("returns null timestamps rather than throwing when reads fail", () => {
      fake.failReads();
      resetSyncStateForTesting();
      expect(getSyncFreshness()).toEqual({
        lastRun: null,
        lastDataAt: null,
        inFlight: false,
      });
    });

    it("surfaces an in-flight run", () => {
      recordSyncStart();
      expect(getSyncFreshness().inFlight).toBe(true);
      recordSyncFinish();
    });
  });
});
