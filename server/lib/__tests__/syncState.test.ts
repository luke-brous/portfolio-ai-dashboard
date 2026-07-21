import { it, expect, describe, beforeEach } from "bun:test";
import {
    getLastRun,
    getSyncSnapshot,
    isSyncInFlight,
    recordSyncFinish,
    recordSyncRun,
    recordSyncStart,
    resetSyncStateForTesting,
} from "./../syncState";

describe("Sync State Utilities", () => {
    beforeEach(() => {
        resetSyncStateForTesting();
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
});
