// 「お金」タブのアイコン（線のインライン SVG。色は currentColor）。読み上げない（aria-hidden）。
const PATHS = {
  back: ['M15 6l-6 6 6 6'],
  next: ['M9 6l6 6-6 6'],
  sync: ['M20 12a8 8 0 0 1-14.3 4.9', 'M4 12a8 8 0 0 1 14.3-4.9', 'M18.5 3.5v4h-4', 'M5.5 20.5v-4h4'],
  warn: ['M12 3l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  found: ['M4 7h16M4 12h10M4 17h7', 'M17 15v6M14 18h6'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  info: ['M12 8h.01', 'M11 12h1v5h1', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  bank: ['M3 10l9-6 9 6', 'M5 10v8M9.5 10v8M14.5 10v8M19 10v8', 'M3 20h18'],
  card: ['M3 6h18v13H3z', 'M3 10h18', 'M7 15h3'],
  wallet: ['M4 7h14a2 2 0 0 1 2 2v9H4z', 'M4 7l11-3v3', 'M16 13h2'],
  cash: ['M3 7h18v10H3z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 20h16'],
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, class: cls }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg aria-hidden="true" class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
