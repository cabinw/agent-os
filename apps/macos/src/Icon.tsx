import type { NavigationIcon } from "./navigation.js";

const paths: Readonly<Record<NavigationIcon, readonly string[]>> = Object.freeze({
  library: ["M3 5h6l2 2h10v12H3z", "M7 11h10M7 15h7"],
  pulse: ["M3 12h4l2-6 4 12 2-6h6"],
  canvas: ["M6 6h4v4H6zM14 4h4v4h-4zM14 16h4v4h-4zM8 10v6h6M10 8h4"],
  tasks: ["M5 4h14v16H5z", "m8 10 2 2 4-5M8 16h8"],
  agents: [
    "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16 10a2.5 2.5 0 1 0 0-5",
    "M3 20c0-4 2-7 5-7s5 3 5 7M13 14c4-1 7 1 8 5",
  ],
  memory: ["M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z", "M8 4v16M11 8h5M11 12h5"],
  settings: [
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    "M19 13.5v-3l-2-.7-.8-1.8.9-2-2.1-2.1-2 .9-1.8-.8-.7-2h-3l-.7 2-1.8.8-2-.9L1.9 6l.9 2-.8 1.8-2 .7v3l2 .7.8 1.8-.9 2L4 20.1l2-.9 1.8.8.7 2h3l.7-2 1.8-.8 2 .9 2.1-2.1-.9-2 .8-1.8z",
  ],
});

export function Icon({ name }: Readonly<{ name: NavigationIcon }>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
