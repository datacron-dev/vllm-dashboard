# Layout Fixes — Changelog

## Date: 2026-09-29

### Issue
The vLLM Dashboard layout didn't match the AppImage reference screenshot. The System Monitor panel's structure was incorrect, and the Server Logs panel was missing the Auto-scroll toggle.

### Changes Made

#### 1. `src/index.html` — System Monitor Panel Restructure
**Before:** Vertical card layout with labels stacked above values inside `.sysmon-card` containers.

**After:** Horizontal card-row layout matching the reference screenshot:
- **GPU row** — Individual cells in a single row: MODEL, UTILIZATION, CLOCK, TEMP (with color-coded bar), POWER (with color-coded bar), DRIVER
- **VRAM/Memory row** — Single wide cell with "UNIFIED MEMORY" label, value text, and gradient bar
- **System row** — Individual cells in a single row: OS, ARCH, CPU, CORES, MEMORY (with bar), KERNEL

Also added the **Auto-scroll checkbox** to the Server Logs panel header (matching reference screenshot).

Simplified the **Context Fill** panel — removed the legend, kept the 270° donut with centered percentage and green status dot below (matching reference screenshot).

#### 2. `src/styles.css` — New Layout Classes
- **Removed:** `.sysmon__group`, `.sysmon__title`, `.sysmon__row`, `.sysmon__cell`, `.sysmon__cell--wide`, `.sysmon__cell--row`, `.sysmon-row`, `.sysmon__label`, `.sysmon__value` (old BEM-style names)
- **Added:**
  - `.sysmon-row` — flex row with wrapping for horizontal card layout
  - `.sysmon-row--wide` — full-width row (VRAM/Memory section)
  - `.sysmon-cell` — individual metric card (flex column, background, border, radius)
  - `.sysmon-cell--wide` — wide card for memory section
  - `.sysmon-label` — uppercase label text
  - `.sysmon-value` / `.sysmon-value--inline` / `.sysmon-value--wide` — value text styles
  - `.sysmon-temp-bar` / `.sysmon-power-bar` — full-width color-coded bars under cells
  - `.sysmon-temp-bar__fill--*` / `.sysmon-power-bar__fill--*` — threshold-based colors
  - `.topbar__sep` — vertical separator between brand and endpoint
  - `.context-fill__status` / `.context-fill__status-dot` — green dot indicator below donut

Fixed the logs collapsed state: `.panel--logs[data-collapsed="true"]` now uses `grid-column: 3` instead of `grid-column: 2 / span 1`.

#### 3. `src/app.js` — System Monitor Update Function
- Removed the stray line `setText('#server-uptime-poll', ...)` that was inside the sysmon.update function (it belonged in health.update, which already sets it correctly).
- Updated `sysmon.update()` to target the new element IDs (`#sysmon-gpu-name`, etc.) with class names matching the new CSS structure.
- Fixed temperature/class toggle to use the new `.sysmon-value--warn` / `.sysmon-value--error` class names (no underscores in class names since HTML uses `sysmon-value`).
- Updated `_render()` in the contextFill object to use `#context-fill-arc` and `#context-fill-value` (matching the new HTML IDs instead of old `#context-fill-ring` and `#context-fill-pct`).
- Added green/dim status dot toggle in contextFill `_render()` based on whether there's actual data.
- Added Auto-scroll checkbox handler in `logs.init()` that reads the checkbox state and controls the `autoscroll` property.

### Reference
All changes match the AppImage reference screenshot at:
`Screenshot from 2026-09-29 17-55-51.png`

### Key Design Decisions
1. **Horizontal card rows** in System Monitor — each GPU metric (Model, Utilization, Clock, Temp, Power, Driver) gets its own card cell in a single horizontal row, matching the reference.
2. **Power bar design preserved** — Temperature and Power bars use color-coded thresholds (green/yellow/orange/red for temp, green/yellow/red for power) exactly as the AppImage reference shows.
3. **VRAM/Memory as a single wide bar** — The unified memory display spans the full width of the System Monitor panel with a gradient bar, matching the reference.
4. **Context Fill simplified** — Removed the legend items (Prefilled/Unused) to match the reference's cleaner design. Kept the 270° donut with centered percentage and green status dot.
5. **Auto-scroll checkbox** — Added to the Server Logs panel header, matching the reference screenshot's green checkmark checkbox.
