import { expect, test, describe, mock } from "bun:test";
import app from "../../index";

// Mock the Gemini API call and sleep
mock.module("../../lib/gemini", () => ({
  summarizeText: mock(() => Promise.resolve("Mocked summary")),
}));

mock.module("../../lib/utils", () => ({
  sleep: mock(() => Promise.resolve()),
}));

describe("Gemini summarize route", () => {
  test("POST /summarize returns empty list for empty email array", async () => {
    const res = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summaries: unknown[] };
    expect(json.summaries).toEqual([]);
  });

  test("POST /summarize rejects malformed email objects (missing ID)", async () => {
    const res = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [{ subject: "No ID" }] }),
    });
    // Should be 400 due to Zod validation
    expect(res.status).toBe(400);
  });

  test("POST /summarize returns expected summary shape on success", async () => {
    const res = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emails: [{ id: "1", subject: "Test Email", body: "Hello World" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { summaries: unknown[] };
    expect(json.summaries).toHaveLength(1);
    expect(json.summaries[0]).toEqual({
      id: "1",
      subject: "Test Email",
      from: undefined,
      date: undefined,
      summary: "Mocked summary",
    });
  });
});
