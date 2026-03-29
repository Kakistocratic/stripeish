export default function ThemeSwitcher({ isAlt, onToggle }: { isAlt: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="inline-flex items-center justify-center z-50 gap-2 rounded-md px-6 py-2.5 text-base bg-secondary dark:bg-secondary transition-colors cursor-pointer"
    >
      {isAlt ? 'Default Color' : 'Switch Color'}
    </button>
  );
}
