# Seedance 2.0 Video Integration Notes

This file is the local source-of-truth summary for the Seedance 2.0 video family added to the app.

## Model Families

### Fast

- `bytedance/seedance-2.0/fast/text-to-video`
- `bytedance/seedance-2.0/fast/image-to-video`
- `bytedance/seedance-2.0/fast/reference-to-video`

### Pro

- `bytedance/seedance-2.0/text-to-video`
- `bytedance/seedance-2.0/image-to-video`
- `bytedance/seedance-2.0/reference-to-video`

## Shared Positioning

- ByteDance cinematic video family
- Native audio generation supported
- Strong camera direction and real-world physics
- Fast output resolution options: `480p`, `720p`
- Pro output resolution options: `480p`, `720p`, `1080p`
- Output duration options: `auto`, `4` through `15`
- Shared seed support: `seed`
- Shared optional user tracking field: `end_user_id`

## Text To Video

### Required

- `prompt`

### Optional

- Fast `resolution`: `480p`, `720p`
- Pro `resolution`: `480p`, `720p`, `1080p`
- `duration`: `auto`, `4`-`15`
- `aspect_ratio`: `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`
- `generate_audio`: boolean, default `true`
- `seed`
- `end_user_id`

## Image To Video

### Required

- `prompt`
- `image_url`

### Optional

- `end_image_url`
- Fast `resolution`: `480p`, `720p`
- Pro `resolution`: `480p`, `720p`, `1080p`
- `duration`: `auto`, `4`-`15`
- `aspect_ratio`: `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`
- `generate_audio`: boolean, default `true`
- `seed`
- `end_user_id`

### Important

- `aspect_ratio=auto` should infer from the input image
- `end_image_url` is used for start-to-end frame transitions
- input images support JPEG, PNG, WebP

## Reference To Video

### Required

- `prompt`

### Optional

- `image_urls`: up to `9`
- `video_urls`: up to `3`
- `audio_urls`: up to `3`
- Fast `resolution`: `480p`, `720p`
- Pro `resolution`: `480p`, `720p`, `1080p`
- `duration`: `auto`, `4`-`15`
- `aspect_ratio`: `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`
- `generate_audio`: boolean, default `true`
- `seed`
- `end_user_id`

### Reference Caps

- Maximum total files across all modalities: `12`
- `audio_urls` require at least one image or video reference
- `video_urls` combined duration: `2` to `15` seconds
- `audio_urls` combined duration: up to `15` seconds

## Prompt Token Rules

Seedance reference mode documents prompt tokens as:

- `@Image1`, `@Image2`, ...
- `@Video1`, `@Video2`, ...
- `@Audio1`, `@Audio2`, ...

The app additionally supports a shorthand alias for image references:

- user can type `@1`, `@2`, ...
- before submit, the app normalizes those to `@Image1`, `@Image2`, ...

This shorthand is only intended for Seedance 2.0 reference-to-video models.

## UI Mapping In This App

### Seedance 2.0 Family Tabs

- Text
- Image
- Ref

### Family Variants

- Fast
- Pro

### Reference Upload Areas

- Reference Images
- Reference Videos
- Reference Audio

### Prompt Guidance

The UI should keep showing a token board based on uploaded references so users can see:

- `@1`, `@Image1`
- `@Video1`
- `@Audio1`

## Backend Expectations

- Seedance text and image modes use the normal prompt-based video flow
- Seedance reference mode must not require `image_url`
- Seedance reference mode must pass:
  - `image_urls`
  - `video_urls`
  - `audio_urls`
- validation must enforce image/video/audio and total reference caps

## Pricing Notes

Fast and Pro variants have different per-second and token pricing, but pricing is display/documentation-only here and should not affect payload generation.

## Source Update

As of April 20, 2026, the machine-readable Fal `llms.txt` pages show:

- Fast endpoints: `480p`, `720p`
- Non-fast / Pro endpoints: `480p`, `720p`, `1080p`

This app follows that split even though some older Fal documentation pages still mention only `480p` and `720p`.
