# 3D Model Generation

You can generate 3D furniture models from photographs using the Meshy.ai service.

## How to Generate

1. Open a furniture entry in the editor (create new or edit existing)
2. Make sure the entry has an uploaded **photo**
3. Tap the **"Generate 3D Model"** button
4. If the entry is new (not yet saved), it will be **saved automatically** before generation starts
5. The task enters the **queue** — the button shows "Queued..." until a processing slot opens
6. Once a slot is available, generation begins on the 3D service and the button switches to "Generating..."
7. Progress is shown in the **tracker panel** (bottom-right corner)
8. When complete, the 3D model is automatically downloaded, processed, and attached to the entry

## Queue System

There is a limited number of models that can be actively generated at the same time across all users. When the limit is reached, new requests are **queued** and automatically promoted as slots become available:

- **Queued** — waiting for a processing slot (shown dimmed in the tracker)
- **Active** — currently being generated (shown with a progress bar)
- The tracker displays the active count and queue size (e.g., "3/10 +5 queued")
- You can queue multiple tasks — they will process in order

## Requirements

- A Meshy.ai paid subscription is required (configured by your administrator)
- The entry must have an uploaded photo to use as the source image

## Tips

- Photos with a **clean background** and **good lighting** produce better models
- The generated model's origin is automatically centered at the bottom for correct placement
- After generation, you may want to verify the model looks correct by placing it in a room
- If generation fails, you can retry — transient errors are automatically retried by the server
- You can queue generations for multiple furniture items and continue working while they process
