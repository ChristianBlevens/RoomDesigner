# Stacking Furniture

Place decorative items on top of other furniture — vases on tables, lamps on nightstands, books on shelves.

## How to Stack

1. Tap on a piece of furniture already in the room
2. In the popup menu, tap the **Place On Top** button (the stacking icon between Rotate and Delete)
3. The furniture database opens — browse or search for the item you want
4. The item appears centered on top of the parent furniture
5. Drag or use the move gizmo to reposition it on the surface

## How Children Behave

Items placed on top of furniture become **children** of that piece:

- **Dragging a child** slides it across the parent's top surface only — it cannot leave the parent
- **Rotating a child** spins it on the parent's surface independently
- **Moving the parent** moves all children with it, keeping their relative positions
- **Rotating the parent** rotates all children with it
- **Deleting a child** removes only that item — the parent is unaffected
- **Deleting the parent** removes it and all items on top of it (the confirmation tells you how many)

## Scale

Children scale independently from their parent. When you adjust the room scale slider, both parent and child resize based on their own dimensions, and the child repositions to stay on the parent's new top surface.

## Saving and Layouts

Stacked furniture is saved automatically with the room, and included when you save a layout. Loading a layout restores all parent-child relationships.

## Limitations

- You can stack one level deep — items on top of furniture cannot themselves have items placed on them
- The **Place On Top** button does not appear when you select an item that is already stacked on something else
- Children cannot be dragged off their parent onto the room surface — delete and re-place instead
