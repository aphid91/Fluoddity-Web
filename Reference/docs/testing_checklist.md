# Fluoddity Manual Testing Checklist

Use this after large refactors or significant new features. Items roughly ordered by breakage risk.

## 1. Config Save/Load System
- [ ] **a.** File → Save: enter name, verify JSON appears in Custom folder
- [ ] **b.** File → Save existing name: overwrite confirmation dialog works
- [ ] **c.** File → Load: click config, verify rule + sliders + appearance applied
- [ ] **d.** Hover preview: hover over config names, verify live preview (particles change)
- [ ] **e.** Preview restore: move mouse away from menu, verify original state restored
- [ ] **f.** Watercolor lock: right-click in Load submenu toggles watercolor for all previews
- [ ] **g.** Category headers: Core/Custom/Advanced collapse/expand, state persists across opens
- [ ] **h.** N button: shows notes tooltip (blue when notes exist)
- [ ] **i.** X button: opens delete confirmation, file removed on confirm
- [ ] **j.** Clipboard: Ctrl+C copies config, Ctrl+V pastes and applies
- [ ] **k.** Saves preserve: jitter values, custom slider ranges, parameter sweep assignments, notes

## 2. Particle Selection & Rule History
- [ ] **a.** Left click selects particle, applies its mutated rule (1-frame deferred readback)
- [ ] **b.** Right click undoes last selection (pops rule stack)
- [ ] **c.** History window shows colored jersey numbers, newest first
- [ ] **d.** Hover history entry: live preview of that rule
- [ ] **e.** Click history entry: moves rule to top of stack
- [ ] **f.** X button in history: deletes that rule entry
- [ ] **g.** Z key: full reset (zero rule + new seed + push to history)
- [ ] **h.** M key: randomize mutations (same rule, new seed, push to history)
- [ ] **i.** R key: simple reset (particles only, rule unchanged)

## 3. Physics Sliders
- [ ] **a.** All 12 sliders respond and affect simulation in real-time
- [ ] **b.** Right-click context menu opens on each slider
- [ ] **c.** Jitter slider works (orange tint, range shown in label)
- [ ] **d.** Jitter hidden for Hazard Rate and Mutation Scale
- [ ] **e.** Min/Max fields adjust range; "Reset Range" restores defaults
- [ ] **f.** "Reset Value" button works (shows loaded config name if applicable)
- [ ] **g.** Ctrl+click on slider allows direct number entry
- [ ] **h.** Hazard Rate uses power scaling (fine control at low values)
- [ ] **i.** Hard limits enforced: Drag/Sensor Angle (±1.0), Trail Persistence/Diffusion (0-1.0)
- [ ] **j.** Physics tooltips: enable in preferences, hover slider shows animated diagram

## 4. Parameter Sweeps
- [ ] **a.** Enable checkbox toggles X/Y/C buttons on sliders
- [ ] **b.** X button: left-click = normal (bright red), right-click = inverse (dark red)
- [ ] **c.** Y button: same pattern, green
- [ ] **d.** C button (cohort): same pattern, yellow
- [ ] **e.** Left click on canvas: updates slider values from position (XY) or particle cohort (C)
- [ ] **f.** Right click on canvas: enters preview mode (sweeps disabled, window tints blue)
- [ ] **g.** Any click while preview pending: re-enables sweeps
- [ ] **h.** Sweep reticle visible on canvas, hidden during recording/screenshot
- [ ] **i.** Range adjust buttons (^ v): widen/narrow range around current value

## 5. Video Recording
- [ ] **a.** Record key toggles recording on/off
- [ ] **b.** While recording: speedmult/motion blur locked to recording settings
- [ ] **c.** Stop recording: user settings restored
- [ ] **d.** Delayed start: set Video End Frame > 0, recording starts at calculated frame
- [ ] **e.** Pending state: shows countdown, can cancel with record key
- [ ] **f.** Video saved to Documents/Fluoddity/ with timestamp
- [ ] **g.** Recording window shows status (RECORDING / WAITING / idle)

## 6. Screenshots
- [ ] **a.** Shift+P takes screenshot
- [ ] **b.** Settings temporarily overridden (max quality motion blur)
- [ ] **c.** Settings restored after save (including pause state)
- [ ] **d.** File saved to Documents/Fluoddity/screenshots/ with timestamp
- [ ] **e.** Supersample factor applied

## 7. Multi-Load Mode
- [ ] **a.** Extras → Multi Load Mode enables
- [ ] **b.** File → Load adds configs (max 64), menu stays open
- [ ] **c.** Physics window switches to multi-load layout
- [ ] **d.** Mouse mode forced to Draw Trail
- [ ] **e.** Parameter sweeps force-disabled
- [ ] **f.** Simultaneous configs / Progression Pace / Current Progress sliders work
- [ ] **g.** Remove buttons remove individual configs
- [ ] **h.** Per-config toggles (Initial Conditions, Cohorts, Hazard Rate) grey out respective controls

## 8. Appearance & View
- [ ] **a.** Color by Cohort toggle (hides Hue Sensitivity when on)
- [ ] **b.** Watercolor Mode toggle (V key), shows Ink Weight when on
- [ ] **c.** Emboss Mode combo (Off/Canvas/Brush), shows Intensity + Smoothness when on
- [ ] **d.** Brightness slider affects output
- [ ] **e.** Exposure slider works
- [ ] **f.** View option dropdown cycles views
- [ ] **g.** Tiling mode (view option 3): camera wraps, exiting wraps position back to center

## 9. Preferences
- [ ] **a.** World size change triggers full rebuild (expensive, console output)
- [ ] **b.** Physics frequency slider (locked label during recording)
- [ ] **c.** Motion blur toggle + blur quality slider
- [ ] **d.** Mouse mode dropdown (locked text in multi-load)
- [ ] **e.** Draw size / Draw power visible only in Draw Trail mode
- [ ] **f.** Debug arrows toggle + sensitivity slider
- [ ] **g.** Preferences saved on exit, restored on next launch

## 10. Menu Auto-Close
- [ ] **a.** Main menu bar: menus close when mouse moves far away
- [ ] **b.** Physics settings menu bar: same behavior
- [ ] **c.** Slider context menus: same behavior
- [ ] **d.** Save dialog open prevents auto-close

## 11. Camera & Input
- [ ] **a.** WASD movement
- [ ] **b.** QE zoom in/out
- [ ] **c.** Scroll wheel zoom (centered on mouse pointer)
- [ ] **d.** V key: reload shaders (hot reload)
- [ ] **e.** Keybindings from keyboard_controls.json respected

## 12. Help Windows
- [ ] **a.** Help → Controls: lists all shortcuts
- [ ] **b.** Help → Tutorial: all collapsible sections open/close
- [ ] **c.** Help → Parameter Sweeps: info window opens
- [ ] **d.** Help → Performance: opens
- [ ] **e.** Help → Video Recording: shows recording status + all controls
