import { useLabels } from "../hooks/useLabels";

export default function LabelPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (label: string) => void;
}) {
  const { data, isLoading, error } = useLabels();

  if (isLoading) return <div className="text-sm text-slate-500">Loading labels...</div>;
  if (error) return <div className="text-sm text-red-500">Error loading labels</div>;

  const labels = data?.labels || [];

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-white border border-slate-300 text-slate-700 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block px-4 py-3 outline-none transition-colors duration-200"
    >
      <option value="" disabled>
        Select a label
      </option>
      {labels.map((label) => (
        <option key={label.id} value={label.id}>
          {label.name}
        </option>
      ))}
    </select>
  );
}
