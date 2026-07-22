import { describe, it, expect } from "bun:test";

import {
  decodeBase64Url,
  getHeader,
  extractBody,
  buildGmailQuery,
} from "../gmail";

describe("Gmail Parser Utilities", () => {
  describe("buildGmailQuery", () => {
    it("should build a query with all parameters", () => {
      expect(
        buildGmailQuery({
          label: "inbox",
          after: "2026-06-01",
          before: "2026-06-30",
        }),
      ).toBe("label:inbox after:2026-06-01 before:2026-06-30");
    });

    it("should build a query with only some parameters", () => {
      expect(buildGmailQuery({ after: "2026-06-01" })).toBe("after:2026-06-01");
    });

    it("should return undefined if no parameters are provided", () => {
      expect(buildGmailQuery({})).toBeUndefined();
    });
  });

  describe("decodeBase64Url", () => {
    it("should decode standard base64url strings", () => {
      // "SGVsbG8gV29ybGQ=" is "Hello World" in base64
      expect(decodeBase64Url("SGVsbG8gV29ybGQ=")).toBe("Hello World");
    });

    it("should safely handle base64url specific characters (- and _)", () => {
      // Create a string that requires + and / in standard base64
      const original = "Hello? World>";
      // Convert it to base64url format
      const b64url = Buffer.from(original)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      expect(decodeBase64Url(b64url)).toBe(original);
    });
  });

  describe("getHeader", () => {
    const mockHeaders = [
      { name: "Subject", value: "Project Update" },
      { name: "From", value: "boss@company.com" },
      { name: "Date", value: "Mon, 1 Jul 2026 10:00:00 -0400" },
    ];

    it("should return the correct header value", () => {
      expect(getHeader(mockHeaders, "Subject")).toBe("Project Update");
    });

    it("should be case-insensitive when searching for header names", () => {
      expect(getHeader(mockHeaders, "fRoM")).toBe("boss@company.com");
    });

    it("should return undefined if the header does not exist", () => {
      expect(getHeader(mockHeaders, "Reply-To")).toBeUndefined();
    });
  });

  describe("extractBody", () => {
    it("should extract text/plain from a simple payload", () => {
      const payload = {
        mimeType: "text/plain",
        body: { data: Buffer.from("Simple text data").toString("base64") },
      };
      expect(extractBody(payload)).toBe("Simple text data");
    });

    it("should strip HTML tags if only text/html is available", () => {
      const payload = {
        mimeType: "text/html",
        body: {
          data: Buffer.from("<h1>Important</h1><p>Update</p>").toString(
            "base64",
          ),
        },
      };
      expect(extractBody(payload)).toBe("ImportantUpdate");
    });

    it("should return an empty string if no valid data is found", () => {
      const emptyPayload = { mimeType: "application/pdf" };
      expect(extractBody(emptyPayload)).toBe("");
    });
  });
});
