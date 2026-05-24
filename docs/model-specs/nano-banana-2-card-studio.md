# Nano Banana 2 Card Studio Prompting

This note captures the prompting rules we use for Card Studio with `fal-ai/nano-banana-2/edit`.

## Source Material

- Fal learn guide: <https://fal.ai/learn/tools/how-to-use-nano-banana-2>
- Fal API docs: <https://fal.ai/models/fal-ai/nano-banana-2/edit/api>
- Fal model overview: <https://fal.ai/nano-banana-2>

## Working Rules

1. Use natural-language edit instructions instead of terse keyword piles.
2. Clearly separate:
   - what must be preserved
   - what may change
   - what each reference image is responsible for
3. Keep quoted user text immutable.
4. Give each reference image family one job:
   - product photos: exact product preservation
   - typography references: headline treatment only
   - design inspiration: overall card art direction and layout
5. Ask for one coherent final composition, not a collage of reference parts.
6. When references disagree, define an authority order explicitly.
7. Prefer search off for creative product-card generation unless real-world grounding is actually needed.

## Card Studio Mapping

- Product image is the source of truth for product identity.
- Font preset images are treated as typography references, including:
  - letterforms
  - color and gradients
  - transparency / opacity
  - outline, glow, bevel, emboss, shadow
  - curvature, distortion, perspective, and graphic presence
- Design inspiration images control:
  - layout
  - background
  - panels / boxes / overlays
  - icon language
  - spacing and hierarchy
  - decorative style

## Prompt Intent

The model should produce a card that is:

- exact about the product
- exact about the text
- high-fidelity about style transfer
- still original and creative as a final composition
