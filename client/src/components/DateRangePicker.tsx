export default function DateRangePicker({
  value,
  onChange,
}: {
  value: { after: string; before: string } | null;
  onChange: (range: { after: string; before: string }) => void;
}) {
  return (
    <div className="flex flex-row gap-4 items-center">
      <div className="relative flex-1">
        <input
          type="date"
          className="w-full bg-white border border-slate-300 text-slate-700 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block px-4 py-3 outline-none transition-colors duration-200"
          value={value?.after ?? ""}
          onChange={(e) => onChange({ after: e.target.value, before: value?.before ?? "" })}
        />
      </div>
      <span className="text-slate-400 font-light">to</span>
      <div className="relative flex-1">
        <input
          type="date"
          className="w-full bg-white border border-slate-300 text-slate-700 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block px-4 py-3 outline-none transition-colors duration-200"
          value={value?.before ?? ""}
          onChange={(e) => onChange({ after: value?.after ?? "", before: e.target.value })}
        />
      </div>
    </div>
  );
}