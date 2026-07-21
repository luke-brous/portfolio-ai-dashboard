export default function ExportButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={() => (window.location.href = "/export/csv")}
    >
      Export to CSV
    </button>
  );
}
