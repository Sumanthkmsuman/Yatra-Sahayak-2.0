# Roadmap

- [x] Google Places autocomplete on location fields (kept working)
- [x] Multi-provider place discovery: Geoapify primary, Google Places secondary, OSM/Overpass fallback
- [x] Geocoding of any city/village/taluk/district/landmark with spelling tolerance
- [x] Merge/dedupe by provider ID or name + coordinate proximity, source labels kept
- [x] Haversine distances, 1/5/10/25/50/100 km + All filters, sorting (recommended, nearest, farthest, popular, rated)
- [x] Map with markers (name, distance, address, rating, source) fitted to location + results
- [x] Debounce, stale-request cancellation, 5-minute result cache, no AI in the geographic path
- [x] Near Me uses GPS only after permission and labels GPS vs searched location
- [x] Provider status/settings panel; keys stay server-side secrets
