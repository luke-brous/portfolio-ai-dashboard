import type { Summary } from "../types";

export default function SummaryCard({ summary }: { summary: Summary }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "0.75rem",
        background: "white",
      }}
    >
      <strong>{summary.from}</strong>
      <p style={{ margin: "0.25rem 0", color: "#666", fontSize: "0.85rem" }}>
        {summary.subject} · {summary.date}
      </p>
      <p>{summary.summary}</p>
    </div>
  );
}
