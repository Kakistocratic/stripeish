export default function ThemeSwitcher({ isAlt, onToggle }: { isAlt: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="inline-flex items-center gap-2 rounded-md border border-black/15 bg-transparent px-6 py-2.5 text-sm text-[#0a2540] hover:bg-black/4 hover:border-black/25 transition-colors cursor-pointer"
    >
      {isAlt ? 'Default Color' : 'Switch Color'}
    </button>
  );
}
