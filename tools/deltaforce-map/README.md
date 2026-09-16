# Delta Force official map tile exporter

This utility is intended to run in **GitHub Actions**, not Colab.

It reads the public Delta Force map page and its JavaScript files, extracts candidate tile-layer names, verifies them against Tencent's official image CDN, detects the highest native zoom, downloads the full tile grid at that zoom, stitches each valid layer into one JPG, and uploads the results as a GitHub Actions artifact.

## Run it

1. Open this repository's **Actions** tab.
2. Select **Delta Force Full Map Export**.
3. Click **Run workflow**.
4. Normally leave the defaults unchanged and run it.
5. When the job finishes, download `delta-force-full-maps-<run number>` from the **Artifacts** section of that workflow run.

The artifact contains:

- `maps/*.jpg` — stitched full maps;
- optional `maps/*.png` — lossless copies when `save_png=true`;
- `meta/manifest.csv` and `meta/manifest.json` — layer, zoom, tile range, image size and source URL template;
- `meta/discovery.json` — what official pages/scripts were parsed and what candidate layers were found;
- `meta/verified_layers.json` — candidates that actually returned valid image tiles;
- `meta/failures.json` — per-layer failures, if any.

## Inputs

- `max_zoom`: highest zoom to probe. Default `6`; current official maps are usually detected at native `z=4`.
- `workers`: concurrent requests. Default `16`.
- `save_png`: also emit PNG. Off by default because it makes artifacts much larger.
- `keep_tiles`: retain every source tile. Off by default.
- `only_layers`: optional comma-separated whitelist, for example `map_db,map_yc`.
- `extra_layers`: optional candidate names to add to auto-discovery after a game update.

## Reliability choices

The workflow does **not** require a browser. If the main Tencent page is slow or unavailable from a GitHub runner, it still attempts known static JS URLs and a verified fallback candidate set. A fallback name is never accepted merely because it is listed: the downloader must receive and decode a real image tile from the official CDN first.

The repository does not store the downloaded game maps. Outputs are temporary GitHub Actions artifacts retained for seven days.
