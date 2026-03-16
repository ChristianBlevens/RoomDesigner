# Creating a Room

## Steps

1. Tap the **"+" tab** at the bottom of the screen
2. **Upload or take a photo** of the room
3. Enter a **name** for the room
4. Choose whether to **clear the room** photo:
   - **"Clear Room"** — AI removes existing furniture and clutter, producing a clean empty room. Best for rooms that are already furnished
   - **"Keep As-Is"** — uses the original photo unchanged
   - Optionally enter a **floor type hint** (e.g., "hardwood", "carpet", "tile") to help the AI reconstruct floors hidden under furniture
5. Wait for **AI processing** — the app extracts 3D room geometry. This takes 30-60 seconds (60-90 seconds if clearing furniture)
6. The room loads with the photo as background and an invisible 3D mesh for surface interaction

## Cleared vs Original Photo

If you chose to clear furniture, both versions are saved. You can toggle between them in the **wall color panel** — the "Original" card shows a split button with "Cleared" on the left and "Original" on the right.

Wall color generation, exports, and other operations always use the cleared version as the base.

## Tips

- Use photos taken from a **single viewpoint** (not panoramas)
- **Good lighting** and **clear walls/floors** help the AI extract better geometry
- The AI works best with typical interior spaces — rooms with standard walls, floors, and ceilings
- If the room has heavy furniture covering the floor, use the **floor type hint** to improve clearing results
- You can add multiple rooms to a single house
