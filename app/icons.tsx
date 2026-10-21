// 侧栏和按钮用的线条图标。只画简单几何形，统一 24×24、1.8 线宽，颜色跟随文字。
export type IconName =
  | "create" | "scripts" | "remix" | "fission" | "products" | "gems" | "tasks"
  | "publisher" | "calendar" | "settings" | "plus" | "minus" | "upload";

const PATHS: Record<IconName, string[]> = {
  create: ["M12 3l1.8 4.6 4.7 1.8-4.7 1.8L12 16l-1.8-4.8-4.7-1.8 4.7-1.8z", "M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"],
  scripts: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h6"],
  remix: ["M17 2l4 4-4 4", "M3 11V9a3 3 0 0 1 3-3h15", "M7 22l-4-4 4-4", "M21 13v2a3 3 0 0 1-3 3H3"],
  fission: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"],
  products: ["M21 8l-9-5-9 5v8l9 5 9-5z", "M3 8l9 5 9-5", "M12 13v8"],
  gems: ["M6 3h12l4 6-10 12L2 9z", "M2 9h20", "M10 3L8 9l4 12 4-12-2-6"],
  tasks: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  publisher: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"],
  calendar: ["M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M16 2v4", "M8 2v4", "M3 10h18"],
  settings: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"],
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {PATHS[name].map(d => <path key={d} d={d} />)}
  </svg>;
}
