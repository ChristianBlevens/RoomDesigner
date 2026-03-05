# Rooms

Each house contains one or more rooms. A room is created from a photograph, which the app processes to extract 3D geometry for furniture placement.

## Room Tabs

Rooms appear as tabs at the bottom of the screen. Tap a tab to switch rooms. The "+" tab adds a new room.

## Room Data

Each room stores:

- A **background photograph** (the original room image)
- **3D mesh geometry** extracted from the photo by AI
- **Placed furniture** with positions, rotations, and surface data
- **Lighting settings** (intensity, temperature, direction)
- **Room scale** multiplier
- **Meter stick** position and visibility (if placed)

## Saving

Room state saves automatically when you:

- Switch to a different room
- Close the house
- The save is smart — only changed fields are sent to the server
