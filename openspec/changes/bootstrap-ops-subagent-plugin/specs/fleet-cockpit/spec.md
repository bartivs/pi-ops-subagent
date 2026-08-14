## Purpose

The fleet cockpit is a live, keyboard-driven tabbed widget showing every running and finished probe agent — phase,
elapsed time, last activity, per-tool activity log, raw tool-output tail, and final digest — so users watch
operations without any raw output entering the conversation.

## ADDED Requirements

### Requirement: Live widget presence
The system SHALL display a tabbed widget whenever sub-agents are running or recently finished, and remove it when
none remain.

#### Scenario: Widget appears and clears
- **WHEN** the first sub-agent starts
- **THEN** the widget renders above the editor; when the last entry expires, the widget is removed

### Requirement: Per-agent tabs
Each running/finished agent SHALL be a tab in a strip; the selected tab shows full detail: phase
(starting/active/done/failed), elapsed time, tool-call count, last activity label, activity log, output tail, and
final digest (scrollable when finished).

#### Scenario: Tab detail
- **WHEN** a tab is selected
- **THEN** its phase, elapsed, activity log, output tail, and digest (if finished) are displayed

### Requirement: Keyboard navigation
The widget SHALL support keyboard navigation: engage mode (`Alt+o`), cycle (`←`/`→`/`Tab`/`Shift+Tab`), jump
(`1`-`9`), expand (`Enter`), summary (`s`), auto-follow toggle (`f`), scroll (`↑`/`↓`/`PgUp`/`PgDn`), collapse
(`Esc`), exit (`q`/`Alt+o`), with passive `Ctrl+Tab`/`Ctrl+Shift+Tab` cycling when not engaged.

#### Scenario: Engagement gate
- **WHEN** the user is typing in the editor
- **THEN** widget keys do not steal input unless the user explicitly engages the widget with `Alt+o`

#### Scenario: Navigation works when engaged
- **WHEN** the widget is engaged
- **THEN** all documented keys navigate the tabs as specified

### Requirement: Auto-follow and pulse
The widget SHALL auto-follow the newest active agent while running, and SHALL pulse (flash) non-focused tabs on
activity without stealing focus.

#### Scenario: Auto-follow
- **WHEN** a new agent becomes active and the user has not manually selected a tab
- **THEN** the widget shows that agent's detail

#### Scenario: Pulse on activity
- **WHEN** a non-focused tab records activity
- **THEN** the tab flashes briefly while the current selection is preserved

### Requirement: Context hygiene
The widget SHALL render only from the observability registry; its rendering SHALL never inject raw tool output into
the parent conversation.

#### Scenario: No context pollution
- **WHEN** the widget is rendering tool output tails
- **THEN** only the renderer sees it; the parent conversation contains only digests

### Requirement: Reload safety
The widget timer and input listener SHALL be reload-safe (survive `/reload`, no duplicate timers/listeners).

#### Scenario: Reload without dupes
- **WHEN** pi extensions are reloaded while the widget is active
- **THEN** exactly one timer and one input listener exist and state resets cleanly

### Requirement: Headless safety
All widget code SHALL be guarded so headless/json modes never attempt UI calls.

#### Scenario: Headless run
- **WHEN** pi runs in `--mode json` or `-p`
- **THEN** no widget calls are attempted and sub-agent runs complete normally