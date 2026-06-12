# wipe

**Kind:** transition | **Author:** studio-fps | **License:** Apache-2.0 | **Version:** 1.0.0

Directional clip-path wipe transition.

The entering scene is revealed by a clip-path that expands from the leading edge
in the chosen direction. Four directions are supported: left, right, up, down.

Built entirely on `remotion` primitives — no external animation libraries.

## Props

| Prop      | Type                            | Required | Default | Description                |
|-----------|---------------------------------|----------|---------|----------------------------|
| direction | "left" \| "right" \| "up" \| "down" | no   | "left"  | Direction the wipe travels |

## Example

```json
{
  "direction": "right"
}
```

## How it works

Uses CSS `clip-path: inset(...)` on the entering scene, animated from
`presentationProgress` (0→1 over the transition duration). The exiting scene
sits still beneath; no transform applied.
