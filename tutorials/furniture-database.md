# Furniture Database

The furniture database is shared across your organization. All houses and rooms pull from the same inventory.

## Browsing

- **Search** — type in the search bar to filter by name
- **Category** — use the dropdown to filter by category
- **Tags** — use the multi-select dropdown to filter by tags

## Furniture Cards

Each card shows:

- A **thumbnail** (2D photo if available, 3D preview as fallback)
- A **"3D" badge** if the entry has a placeable 3D model
- **Availability** badge based on the current house's date range:
  - **Green** — available. Hover/tap the badge to see which houses are using it
  - **Amber with warning** — available, but some units were recently at another house within the de-staging buffer period and may not be back yet
  - **Red** — unavailable due to date overlap with other houses

Hover or tap any availability badge to see a **tooltip** listing which houses the furniture is placed in, with house names and date ranges.

## De-staging Buffer

At the top of the furniture modal, you can set a **de-staging buffer** (in days). This warns you when furniture was recently at another house that ended shortly before the current house starts — even though dates don't technically overlap, the furniture may not be physically returned yet.

- Set to **0** (default) to disable buffer warnings
- Typical values: **1-3 days**
- The setting applies to all availability calculations for your organization

## Adding a New Entry

1. Tap the **"+ Add Entry"** button
2. Fill in the name, category, tags, and dimensions (width, height, depth in centimeters)
3. Upload a **photo** of the furniture (optional but recommended)
4. Upload a **3D model** in GLB format, or generate one from the photo using Meshy.ai
5. Set the **quantity** — how many of this item your organization owns
6. Save the entry

## Editing and Deleting

- Long-press or right-click a furniture card for options
- Changes to an entry affect all rooms where it's placed
- Deleting an entry removes all placed instances from all rooms
