// Thin wrapper around the Gemini API for summarization.
// Get a free key at https://aistudio.google.com

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent";

export async function summarizeText(content: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text:
                "Summarize this nonprofit update email in 2-3 bullet points, focusing on programs, impact, and any financial figures. Only the brief no additional text:\n\n" +
                content,
            },
          ],
        },
      ],
    }),
  });

    const data = (await response.json()) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    if (!response.ok) {
      throw new Error(
        `Gemini API error: ${data.error?.message || "Unknown error"}`
      );
    }

    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;

    return summary || "No summary returned from Gemini API";

}
