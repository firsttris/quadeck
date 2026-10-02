// Stroke icons (24×24, currentColor). Also the neutral category icons used
// when no dashboard-icon or favicon is available.

export const GLYPHS: Record<string, string[]> = {
  overview: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  units: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  journal: ['M5 3h14v18H5z', 'M9 7h6', 'M9 11h6', 'M9 15h4'],
  logout: ['M9 21H5V3h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  plus: ['M12 5v14M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  restart: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  stop: ['M6 6h12v12H6z'],
  start: ['M8 5v14l11-7z'],
  play: ['M8 5v14l11-7z'],
  image: ['M4 5h16v14H4z', 'M9 9.5a1.5 1.5 0 1 0 0 .01', 'M4 17l5-5 4 4 3-3 4 4'],
  tag: ['M3 12V4h8l9 9-8 8z', 'M7.5 7.5h.01'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  magnet: ['M6 4v8a6 6 0 0 0 12 0V4', 'M6 8h4', 'M14 8h4'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 19V5'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10', 'M10 20v-5h4v5'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  key: ['M8 10a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M11 13l9-9', 'M17 7l3 3'],
  globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'],
  router: ['M4 14h16v5H4z', 'M8 16.5h.01', 'M12 14V9', 'M8.5 7a5 5 0 0 1 7 0'],
  printer: ['M7 8V3h10v5', 'M5 8h14v8H5z', 'M7 14h10v7H7z'],
  bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  box: ['M3 7l9-4 9 4v10l-9 4-9-4z', 'M3 7l9 4 9-4', 'M12 11v10'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  cloud: ['M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z'],
  code: ['M8 6l-5 6 5 6', 'M16 6l5 6-5 6'],
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M20 20l-3.5-3.5'],
}

export function Glyph({ name, size = 17, strokeWidth = 1.8 }: { name: string; size?: number; strokeWidth?: number }) {
  const paths = GLYPHS[name] ?? GLYPHS.box!
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export function Logo() {
  return (
    <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px]" style={{ background: 'linear-gradient(135deg,#7cc4b8,#4f8fbf)', boxShadow: '0 0 20px rgba(124,196,184,.35)' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0b0f14" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 14h18l-2.5 5h-13z" />
        <path d="M6 14V9h4v5" />
        <path d="M12 14V6h5v8" />
      </svg>
    </div>
  )
}
