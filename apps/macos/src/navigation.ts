import { type Locale, t } from "./i18n.js";

export const ROUTE_IDS = Object.freeze([
  "project-library",
  "project-pulse",
  "canvas",
  "tasks",
  "agents",
  "memory",
  "settings",
] as const);

export type RouteId = (typeof ROUTE_IDS)[number];
export type NavigationIcon =
  | "agents"
  | "canvas"
  | "library"
  | "memory"
  | "pulse"
  | "settings"
  | "tasks";

export type NavigationItem = Readonly<{
  id: RouteId;
  icon: NavigationIcon;
}>;

export const NAVIGATION = Object.freeze([
  { id: "project-library", icon: "library" },
  { id: "project-pulse", icon: "pulse" },
  { id: "canvas", icon: "canvas" },
  { id: "tasks", icon: "tasks" },
  { id: "agents", icon: "agents" },
  { id: "memory", icon: "memory" },
  { id: "settings", icon: "settings" },
] as const satisfies readonly NavigationItem[]);

export function labelFor(route: RouteId, locale: Locale): string {
  return t(locale, `nav.${route}.label`);
}

export function descriptionFor(route: RouteId, locale: Locale): string {
  return t(locale, `route.${route}.description`);
}

export function landingRoute(hasActiveProject: boolean): RouteId {
  return hasActiveProject ? "project-pulse" : "project-library";
}
