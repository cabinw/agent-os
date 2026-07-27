# Design Language

**Canonical.** Derived from the renders in `ui/`.

## Character

A calm white instrument panel. The system reports on autonomous work that a
person is not watching continuously, so the interface must make status legible
at a glance and never manufacture urgency. Color carries meaning; it is not
decoration.

macOS-native in feel: real window chrome, standard traffic lights, familiar
spacing, no invented widgets where a platform control exists.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#F7F8FA` | App background |
| `--surface` | `#FFFFFF` | Cards, panels |
| `--border` | `#E8EAED` | Hairlines, card edges |
| `--text` | `#111827` | Primary text |
| `--text-muted` | `#6B7280` | Secondary text |
| `--accent` | `#6366F1` → `#8B5CF6` | Primary actions, active nav, brand gradient |
| `--ok` | `#10B981` | On track, completed |
| `--warn` | `#F59E0B` | Paused, attention |
| `--risk` | `#EF4444` | Blocked, failed |
| `--info` | `#3B82F6` | Neutral informational |

Status color is reserved for status. A green bar always means healthy progress;
it is never used to brighten a layout.

## Type

System font stack (SF Pro on macOS, PingFang SC for Chinese). Chinese and Latin
share the scale — no separate typographic treatment per language.

```
Page title     28 / 600
Section title  15 / 600
Card title     14 / 600
Body           13 / 400
Meta           12 / 400   --text-muted
Number (KPI)   30 / 650   tabular figures
```

Numbers use tabular figures everywhere. A progress percentage that shifts width
as it ticks is a defect.

## Elevation and shape

```
Card       radius 12   border 1px --border   shadow 0 1px 2px rgba(0,0,0,.04)
Panel      radius 14   shadow 0 8px 24px rgba(0,0,0,.08)
Popover    radius 16   shadow 0 16px 48px rgba(0,0,0,.16)
Control    radius 8
Chip       radius 6    12px text
```

Elevation communicates layering only. A card does not lift on hover unless it is
being dragged.

## Layout

8px base grid. Card padding 16–20px. Gaps 12–16px. Content max-width 1440px.

The recurring pattern is a KPI row, a hero, then a card grid — three columns at
desktop width, collapsing to two then one. Sidebar is fixed at 220px and does
not collapse; the seven destinations are the product's map and hiding it costs
more than the space it saves.

## Motion

| Action | Duration | Curve |
| --- | --- | --- |
| Hover / press | 120ms | ease-out |
| Panel open | 220ms | cubic-bezier(.2,.8,.2,1) |
| Progress change | 400ms | ease-in-out |
| Live feed arrival | 200ms fade + 8px rise | ease-out |

Live data animates in, never blinks. An agent event arriving should be
noticeable in peripheral vision without demanding a look.

## Density

Two modes. Comfortable is default. Compact reduces vertical rhythm by ~20% for
users running many agents — it changes spacing only, never hides information.

## Empty and dormant states

Both are common in this product and get real design, not placeholder text. A
dormant project is not an error; its screen leads with Revival Mode. A project
with no agents yet leads with the one action that starts everything.
