# bold-stat

**Kind:** stat | **Author:** acme | **License:** MIT | **Version:** 1.0.0

Bold statistic with count-up.

`value` is displayed in oversized accent-colored text with a pop-in overshoot.
When `value` starts with a whole number (e.g. `"90%"`, `"42 kg"`, `"1,200"`),
the number counts up from 0 to the target over the first ~30 frames. `label`
fades in beneath it.

## Props

| Prop  | Type   | Required | Description                                         |
|-------|--------|----------|-----------------------------------------------------|
| value | string | yes      | The statistic value (e.g. `"90%"`, `"3.5 billion"`) |
| label | string | yes      | Descriptive label shown below the value.            |

## Example

```json
{
  "value": "90%",
  "label": "of materials are recyclable"
}
```

## Styling

Colors and fonts come entirely from the active theme tokens
(`theme.palette.background`, `theme.palette.foreground`, `theme.palette.accent`,
`theme.fonts.heading`, `theme.fonts.body`). No hardcoded values.
