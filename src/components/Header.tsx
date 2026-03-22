"use client";

import React from 'react';

export default function Header() {
  return (
    <header className="w-full flex items-center justify-between px-4 py-3 bg-transparent absolute top-0 left-0 z-30">
      <div className="flex items-center gap-3">

      </div>

      <button aria-label="Open menu" className="w-10 h-10 flex flex-col justify-center items-center gap-1.5">
        <span className="block w-6 h-0.5 bg-white rounded" />
        <span className="block w-6 h-0.5 bg-white rounded" />
        <span className="block w-6 h-0.5 bg-white rounded" />
      </button>
    </header>
  );
}
