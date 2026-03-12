# Furniture Segmenter

The Furniture Segmenter is a standalone tool for extracting individual furniture items from a photo of grouped furniture. Upload a photo, mark each item, and export transparent PNGs — useful for creating furniture database entries from warehouse or delivery photos.

Open it from the **House button** in the controls bar, or navigate directly to the segmentation page.

## How to Use

1. **Upload a photo** — drag and drop or tap "Choose Photo" to load an image containing multiple furniture items
2. **Add objects** — tap the **"+"** button in the right panel to create an object for each item you want to extract
3. **Name objects** — click the object name to rename it (names carry through to exported filenames)
4. **Place points** — select an object in the panel, then tap on the photo to mark where that item is. Place multiple points on the same object to cover different parts (e.g., a desk's top and legs)
5. **Adjust points** — drag any placed point to reposition it
6. **Segment** — tap the **"Segment"** button. The AI analyzes all your points and produces one mask per object
7. **Review results** — each object appears in the right panel with a transparent preview thumbnail

## Editing Masks

After segmentation, you can refine any mask that captured too much or too little:

1. **Select an object** — click its card in the right panel
2. **Choose a mode** — tap **Paint** to add to the mask, or **Erase** to remove from it
3. **Adjust brush size** — use the slider to control the brush radius
4. **Draw on the canvas** — paint or erase directly on the photo. The overlay updates instantly
5. **Undo strokes** — tap **Undo** to reverse the last paint or erase stroke. Each object keeps its own undo history, even when you switch between objects
6. **Preview updates** — the transparent thumbnail in the right panel updates after each stroke

## Exporting

1. **Reject unwanted objects** — tap the **X** button on any object card to exclude it from export
2. **Rename objects** — edit names in the result cards (these become filenames)
3. **Export** — tap **"Export All"** to download a ZIP file containing one transparent PNG per accepted object, cropped to the item's bounds

## Tips

- Place **multiple points** on objects with separate parts — the AI combines them into one mask
- If the AI captures part of a neighboring item, use **Erase** to clean up the boundary
- If the AI misses part of the item, use **Paint** to fill in the gap
- Use **Reset** to clear all results and start over with new point placement
- The tool works entirely in your browser after the AI segmentation step — no data is saved
