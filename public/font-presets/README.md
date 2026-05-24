Built-in font reference presets for Card Studio live in this folder.

How to add a new shared font preset:

1. Put the image file in this folder.
2. Add an entry to `presets.json`.

Format:

```json
[
  {
    "id": "font_luxury_gold",
    "name": "Luxury Gold",
    "thumb": "/font-presets/luxury-gold.jpg"
  }
]
```

Notes:

- Use a unique `id`. A `font_` prefix is recommended.
- `thumb` should be a public path starting with `/font-presets/`.
- JPEG, PNG, and WebP are safe choices.
- These are repo-level presets for all users.
- User-uploaded font presets are still stored per account separately.
