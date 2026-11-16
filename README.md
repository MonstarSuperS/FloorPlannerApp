# FloorPlanner

An interactive 2D floor plan drawing app that runs entirely in your browser. There is nothing to install: open `index.html` in Chrome or Edge.

## Features

- **Walls:** interior (4") and exterior (6") by default, at any angle, with clean mitered corners. A wall's length is its inside face, and its thickness builds outward from the line you draw.
- **Exact lengths:** type a length while drawing (`148`, `12'4"`, `4 1/2`) and press Enter. Show lengths in feet and inches, inches, centimetres or millimetres (the Units switch in the top bar). Any unit can be typed in any mode (`450mm`, `45 cm`, `1.2m`, `1m 20cm`, `4'`); a bare number is in the current unit. In metric, rooms show m² and the grid offers metric sizes (5 mm to 30 cm, with a heavier line every metre).
- **Connections:** shared corners stay joined, and walls can attach to the middle of another wall (T-junctions). Every corner where wall edges meet is a snap point, so you can choose which edge to attach to by hovering it. A wall's edges keep it attached when that wall moves; an outside mitered corner is a position only.
- **Rooms:** enclosed areas are detected automatically, with editable names and square footage.
- **Room dividers:** split one open space into rooms without a wall, such as a kitchen from a dining room. Draw one from wall to wall; it shows as a fine dashed line, and the two areas add up to the undivided room. Dividers stay visible and in exports when construction lines are hidden, and the Inspector can turn one into a construction line and back.
- **Doors and windows:** interior, exterior, bifold, pocket and sliding glass doors, doorless (cased) openings and windows. They attach to walls and slide along them, with flips for swing and hinge. A pocket door shows its pocket as a dashed cavity in the wall, single (`F` swaps the end) or double; the Inspector warns if the pocket runs off the wall or into another opening. A sliding glass door shows two overlapping panels; `F` swaps which half slides. An edge or the centre snaps to wall corners, T walls and construction lines crossing the wall.
- **Fixtures:** bathroom, kitchen, bedroom, living and laundry items (including a gas fireplace), each with standard sizes. Create custom fixtures and save them to the drawing's library. They snap flush to walls, and their sides or centre line up with nearby walls, corners and construction lines. Hold `Alt` while placing or dragging to skip snapping.
- **Drawing shapes:** lines, polylines (click the first point to close one into a polygon), rectangles (with rounded corners), circles, ellipses and arcs, drawn to scale for custom furniture or anything else. Type sizes while drawing: a length for a line, `36 x 20` for a rectangle or ellipse, a diameter for a circle. Shapes snap to walls, corners, construction lines, fixtures, doors and each other, and dimensions attach to their corners, midpoints and centres. Each shape has its own line colour (Auto follows light or dark mode), weight and dash (solid, dashed or dotted); closed shapes can be filled with a colour at any opacity, or with the background so they hide what's under them. Several shapes selected together share one set of style controls, and new shapes take the last style chosen. Drag a line's or arc's points to reshape it, or a rectangle's or ellipse's handles to resize and turn it.
- **Furniture library:** group the shapes of a piece (`Ctrl+G`), then name it and choose **Save as furniture** in the Inspector. It's added to **My Furniture** at the top of the library, saved in the drawing file; drag it onto the plan to place another copy, which arrives as a group that moves, scales and turns as one.
- **Stairs:** straight, L-shaped and U-shaped, with a landing at the turn. Steps are worked out from the floor-to-floor height, a maximum riser height and a tread depth, and the riser count can be overridden. They're drawn with treads, a direction arrow and a break line about 4' up. A stair connects two floors and can be drawn on either: it goes up to the floor above or down to the floor below (the Inspector's Goes setting; stairs drawn on the top floor go down). The lower floor shows it labelled UP and the upper floor labelled DN. Beyond the break line a stair is a dashed, see-through outline by default, so walls and items under it show and can be clicked; each stair can instead show that part solid or hide it. The **Stairs** menu in the floor bar fades or hides all stairs while you work under them (on screen only; exports always show them).
- **Multiple floors,** with the floor below shown as a faint guide underneath and the floor above overlaid faintly in purple (the Floor below and Floor above boxes in the floor bar). Double-click a tab to rename it, and drag it or use the arrow buttons to reorder. Tabs run lowest to highest, left to right. The eye button on a tab hides that floor from both overlays, which then use the next visible floor instead.
- **Locking:** lock any wall, door, window, fixture, stair, text, dimension, line or room (`Ctrl+L`, or Lock in the Inspector) so it can't be moved, resized, rotated, edited or deleted until it's unlocked. Locking a whole selection doesn't group it, so any one item can be unlocked on its own later. A locked item can still be selected; it shows a padlock and its Inspector fields are greyed out. If part of a selection is locked, dragging, arrow keys and Delete are refused with an explanation; hold `Ctrl` to act on just the unlocked items. An unlocked wall dragged away from a locked one separates from it rather than pulling it along, and a wall with a locked door or window stays put. Doors and windows can't be added to a locked wall. Copies come unlocked.
- **Grouping:** `Ctrl+G` groups the selected walls, fixtures, stairs, text, dimensions and lines (doors, windows and rooms go with their walls); `Ctrl+Shift+G` ungroups. Clicking any member selects the whole group, which then has a box with handles: drag it to move, a side or corner handle to scale everything inside (`Shift` on a corner keeps proportions; wall thickness, door widths, text and stair steps keep their real sizes), or the top handle (or `R`) to rotate. Double-click a member to select and edit it alone. Grouping doesn't lock; a group with a locked member moves only with `Ctrl`, leaving that member behind. Pasted copies form a new group.
- **Merging walls:** a wall drawn in several pieces can become one wall. Select its segments and press `Ctrl+M` (or Merge walls in the Inspector). With nothing selected, the Inspector offers **Merge segmented walls** when the floor has walls drawn in in-line pieces, and merges them all at once. The merged wall follows the longest segment's line; pieces up to 2° or 1" off, or 1" apart, are straightened onto it. A wall continued past the end of a wall T'd into it merges across that wall, which becomes a T on it. Doors and windows keep their places, and a wall meeting a joint between segments becomes a T on the merged wall. Segments of a different type or thickness, with their thickness on opposite sides, or locked aren't merged; the status bar says why.
- **Design options:** try changes to a floor, such as a renovation done a few different ways, without touching the plan as it is. Pick **+ New option** in the **Design** menu at the top left of the plan; the plan gets a green border while an option is open. Edit anything as usual: changes stay in the option and the as-is plan is never altered from inside one. Switch between As-is and each option from the same menu. Each option stores only what it changes, so fixes to the as-is plan show up in every option that didn't change the same thing. With **Show changes**, removed or moved walls, doors and fixtures are dashed in red where they were, new or changed ones are green, and each room shows how much its area changed. With nothing selected, the Inspector renames, duplicates or deletes the open option, or makes it the as-is plan once the work is done (the other options keep their designs). PDF export can print the as-is plan and every option, one per page. Files always store the as-is plan, and reopen in the option that was open.
- **Dimension lines and text labels.** Dimensions snap to wall corners, construction lines, and points on items: fixture corners, side midpoints and centres, each end of a door or window on either wall face, and stair corners (a square marker names the point). An end on an item follows it when it moves or is resized, but the dimension is removed once that point has moved more than 12" or the item turned more than 5° from where it was when the dimension was drawn (change these in Settings; `Ctrl+Z` brings a removed dimension back). Moving or turning an item together with its dimension keeps it. A locked dimension stays put and lets go of an item that moves.
- **Construction lines:** reference lines that aren't walls. Walls, other lines and dimensions snap to their ends, midpoints and intersections.
- **Length solving:** hover a construction line, or the level of one of its ends, type a length, and the end lands exactly where that length meets the line. Given a hypotenuse and a rise, this works out the run and angle.
- **Typed lengths** snap to standard angles, or square to what they start from. Hold `Alt` for the exact mouse angle.
- **Extending past a T wall:** a wall continued straight past a wall T'd off its end belongs to the next room, so it starts at that room's inside corner on the T wall's far face and its length is that room's measurement. If the old wall already runs past the T, the typed length is still measured from the T wall's far face. Hold `Alt` to start from the old wall's end instead.
- **Saving:** drawings save as `.fplan` files you can reopen. Once a drawing has a save file, changes auto-save to it (Chrome and Edge).
- **Refreshing keeps your place:** the open drawing, its save file, the floor you were on and the view all come back after a refresh or crash. The browser usually asks once more before writing to the file again: your first click asks, or use the link in the status bar. If the file changed while the page was closed, it is reloaded, unless you had unsaved changes.
- **Labels that keep clear:** zoomed out, room names, areas and lengths get smaller, and any that would run outside their room, along a wall too short for them, or into another label are left out until you zoom in. Room names win over lengths. Text you typed always shows, and exports keep every label at full size.
- **Export:** PNG, JPEG or PDF. PDFs can fit the page or print at a true architectural scale.
- **Settings:** light or dark theme and defaults for new drawings, saved separately from drawing files. They can be backed up to their own file.
- **On a phone:** the app opens as a viewer sized for the screen, for looking at a drawing, checking sizes, measuring and exporting. It can't change the drawing. Open a `.fplan` file from the phone (from Files, Downloads, Drive or a message attachment), then drag to move around, pinch to zoom and double-tap to fit. Tap a room, wall, door, fixture or anything else to see what it is and its sizes. **Measure** gives the distance between two tapped points, landing on corners and wall faces when close. The second point keeps to 45-degree steps from the first (and to the direction of an angled wall it starts on), landing exactly where that line meets a wall face; turn on **Any angle** on the measure card to place it freely. Drag either end to adjust it. **View** holds the units and label switches. **Export** makes the same PNG, JPEG or PDF files as on a computer and hands them to the phone's share sheet (Messages, email, Drive, print). Tablets and phones set to the browser's "Desktop site" get the full editor.

## Controls

| Action | How |
| --- | --- |
| Select, Pan | `V`, `H` |
| Exterior wall, interior wall | `E`, `W` |
| Dimension, text, construction line, room divider, stairs | `D`, `T`, `C`, `B`, `S` |
| Line, polyline (rectangle, circle, ellipse and arc are under Draw in the tools) | `L`, `P` |
| On a phone: move, zoom, fit | Drag, pinch, double-tap |
| On a phone: see what something is | Tap it; tap empty space or the close button to dismiss |
| On a phone: measure | **Measure**, then tap two points; drag an end to adjust. It keeps to 45-degree steps unless **Any angle** is on (or `Alt` is held). `M` and `Esc` with a keyboard |
| Draw a rectangle or ellipse to an exact size | Click the first corner (or centre), type width x depth such as `36 x 20` or `90 x 50cm`, and press `Enter` |
| Finish a polyline | Click its first point to close it; double-click, `Enter` or `Esc` leaves it open. `Backspace` takes back a point |
| Draw a dimension | Click the start, then the end, then where the dimension line goes (it follows the cursor, showing its distance from the middle of what it measures; snaps to the grid unless `Alt` is held) |
| Draw stairs | Click the bottom corner, then click the way they go up (or type the first flight's run and press `Enter`). `F` flips the side. Shape and height are in the Inspector. |
| Finish a wall chain and keep drawing | `Enter` with nothing typed, or `Esc` |
| Cancel and return to Select | Right-click |
| Flip the thickness side while drawing | `F` |
| Lock the wall angle | Hold `Shift` (15, 45 or 90 degree steps, set in the top bar) |
| Skip snapping | Hold `Alt` |
| Zoom, pan | Scroll wheel, middle-drag or hold `Space` and drag |
| Fit the plan on screen | `0` |
| Rotate selected fixture or stairs | `R` for 90 degrees, `Shift+R` for 15 degrees |
| Move selection | Arrow keys (`Shift` for 10x) |
| Undo, redo | `Ctrl+Z`, `Ctrl+Y` |
| Save, Save As, open | `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+O` |
| Copy, cut, paste at the mouse | `Ctrl+C`, `Ctrl+X`, `Ctrl+V` |
| Paste in the original position (e.g. onto another floor) | `Ctrl+Shift+V` |
| Duplicate, select all, delete | `Ctrl+D`, `Ctrl+A`, `Delete` |
| Lock or unlock the selection | `Ctrl+L` |
| Group, ungroup | `Ctrl+G`, `Ctrl+Shift+G` |
| Merge selected wall segments into one wall | `Ctrl+M` |
| Select one item inside a group | Double-click it |
| Move or delete only the unlocked part of a selection | Hold `Ctrl` while dragging, or `Ctrl+Arrow`, `Ctrl+Delete` |

## Project layout

- `index.html`, `css/app.css`: the page.
- `js/`: plain JavaScript with no dependencies or build step.
  - `units`: length parsing and formatting.
  - `geometry`, `model`, `merge`, `options`, `rooms`: the drawing's data and rules, with no page access.
  - `fixtures`, `shapes`, `stairs`, `render`: symbols, drawn shapes and drawing.
  - `app`, `interact`, `ui`, `settings`, `prefs`: application state and interface.
  - `device`, `gestures`, `viewer`, `describe`: phones. `device` picks the layout (compact or full) and the mode (view-only or editing) separately, so touch editing can later be compact without being view-only. `gestures` turns touches into taps, drags and pinches for whatever uses it.
  - `fileio`, `exporter`: saved drawings, images and PDFs.

To try the phone version on a computer, add `?layout=phone` to the address (`?layout=desktop` does the opposite on a phone).

`index.html` carries a Content Security Policy: the page runs and styles itself only from its own files, and loads nothing from the internet. Keep code out of the HTML (no inline `<script>`, `style=` or `onclick=`), since the browser will refuse to run it.

