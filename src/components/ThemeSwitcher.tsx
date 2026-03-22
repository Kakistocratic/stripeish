import { useState } from 'react';

export default function ThemeSwitcher() {
  const [isAlt, setIsAlt] = useState(false);

  function toggle() {
    const next = !isAlt;
    setIsAlt(next);
    const url = next ? '/palette2.webp' : '/palette1.webp';
    if (next) {
      document.documentElement.dataset.theme = 'alt';
    } else {
      delete document.documentElement.dataset.theme;
    }
    window.dispatchEvent(new CustomEvent('palette-change', { detail: url }));
  }

  return (
    <button
      onClick={toggle}
      className="inline-flex items-center gap-2 rounded-md border border-black/15 bg-transparent px-6 py-2.5 text-sm text-[#0a2540] hover:bg-black/4 hover:border-black/25 transition-colors cursor-pointer"
    >
      Switch Color
    </button>
  );
}
