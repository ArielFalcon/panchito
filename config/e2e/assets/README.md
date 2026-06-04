# Test assets (photo upload)

The files (images) that tests upload live here, along with their **optional
metadata** in `assets.json`. The agent reads that metadata to know what to test
with each asset; the path is resolved with `asset("photo.jpg")` (see fixtures).

## `assets.json` — per-asset metadata (optional)

An array of entries. Only `file` is required; the rest explains the use case:

```json
[
  {
    "file": "beach.jpg",
    "description": "Beach photo with geolocation in EXIF",
    "useCase": "upload with a suggested nearby place",
    "whatToTest": "that uploading it shows the nearby-places list and one can be selected"
  }
]
```

| Field | Required | Purpose |
|---|---|---|
| `file` | yes | file name in this folder |
| `description` | no | what the image is |
| `useCase` | no | which flow it is used in |
| `whatToTest` | no | what the test should verify when uploading it |
