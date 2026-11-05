# Herdr Quiet Focus

A calmer, denser Herdr layout for terminal and coding-agent work.

Designed for **Herdr 0.1.13**. The package contains only personal layout and module overrides; it does not include Herdr state, sessions, machine data, credentials, or settings.

## What changes

- Wider tabs with a quieter selected state and a small animated running dot.
- `+` creates a terminal tab directly.
- Agent status is clearer: `Idle` becomes `Ready`; working and completed states use restrained motion.
- The active Agent row has no blue accent strip.
- Spaces use muted neutral icons instead of saturated colors.
- Sidebar width is 320px; labels and icons are easier to read.
- Herdr branding, search, and sidebar collapse controls are removed from the top chrome.
- Terminal framing and outer spacing are reduced so the work area fills the window.
- Pane and tab running indicators use the same visual language.

## Install

```sh
./install.sh
herdr-app do layout.switch '{"name":"main-quiet-focus"}'
herdr-app status
```

The installer copies the layout to `~/.config/herdr-app/layouts/` and the five custom modules to `~/.config/herdr-app/mods/`. Set `HERDR_APP_HOME` when using an isolated Herdr home.

## Roll back

Switch back to the shipped layout:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

To remove the personal files, delete `main-quiet-focus.json` and the five `*-quiet` module directories from `~/.config/herdr-app/`.

## Notification experiment

`experimental/toast-quiet` contains the local notification suppression experiment. Herdr restores its built-in `toast` module on startup, so this file is not installed by default and is not presented as a persistent feature.

## Validation

Verified with Herdr 0.1.13:

```text
herdr-app check mods/tabs-quiet
herdr-app check mods/agents-quiet
herdr-app check mods/spaces-quiet
herdr-app check mods/pane-quiet
herdr-app check mods/workspace-chrome-quiet
```

All five checks passed, and the active Herdr status reported no errors.
