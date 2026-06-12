# kinetic-hook

**Kind:** hook | **Author:** acme | **License:** MIT | **Version:** 1.0.0

Word-cascade opening title with an accent underline sweep.

Words of `title` rise and fade in with a staggered entrance. When `wordTimings`
are provided by the renderer (voice-locked mode), each word lights up as it is
spoken. Without timings the template falls back to an even stagger — always
a clean entrance, never a crash (fail-closed).

An accent underline sweeps in beneath the title once the last word has settled.

## Props

| Prop    | Type   | Required | Description                              |
|---------|--------|----------|------------------------------------------|
| title   | string | yes      | The headline to cascade in word by word. |
| kicker  | string | no       | Small label shown above the title.       |

## Example

```json
{
  "title": "What if glass could flow?",
  "kicker": "MATERIALS"
}
```

## Styling

All colors and fonts are driven by the active theme tokens
(`theme.palette.background`, `theme.palette.foreground`, `theme.palette.accent`,
`theme.fonts.heading`, `theme.fonts.body`). No hardcoded values.
