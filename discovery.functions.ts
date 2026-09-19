import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GOOGLE_GATEWAY = "https://connector-gateway.lovable.dev/google_maps";

export type DiscoveredPlace = {
  id: string;
  name: string;
  address: string;
  locality: string;
  category: string;
  lat: number;
  lng: number;
  rating: number | null;
  reviews: number | null;
  popularity: number;
  source: string;
};

function googleHeaders(extra: Record<string, string> = {}) {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const mapsKey = process.env["GOOGLE_MAPS_API_KEY"];
  if (!lovableKey || !mapsKey) return null;
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": mapsKey,
    "Content-Type": "application/json",
    ...extra,
  } as Record<string, string>;
}

function norm(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---------------- Geocoding: Geoapify -> Google -> Nominatim ---------------- */

type GeoCandidate = {
  name: string;
  label: string;
  lat: number;
  lng: number;
  source: string;
};

async function geoapifyGeocode(text: string): Promise<GeoCandidate[]> {
  const key = process.env["GEOAPIFY_API_KEY"];
  if (!key) return [];
  const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(
    text,
  )}&limit=6&format=json&apiKey=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Geoapify geocode failed [${r.status}]`);
  const j = (await r.json()) as {
    results?: Array<{
      formatted?: string;
      name?: string;
      city?: string;
      county?: string;
      state?: string;
      country?: string;
      lat?: number;
      lon?: number;
    }>;
  };
  return (j.results ?? [])
    .filter((x) => typeof x.lat === "number" && typeof x.lon === "number")
    .map((x) => ({
      name: x.name ?? x.city ?? x.county ?? x.formatted ?? text,
      label: x.formatted ?? text,
      lat: x.lat!,
      lng: x.lon!,
      source: "Geoapify",
    }));
}

async function googleGeocode(text: string): Promise<GeoCandidate[]> {
  const headers = googleHeaders({
    "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
  });
  if (!headers) return [];
  const r = await fetch(`${GOOGLE_GATEWAY}/places/v1/places:searchText`, {
    method: "POST",
    headers,
    body: JSON.stringify({ textQuery: text, maxResultCount: 5 }),
  });
  if (!r.ok) throw new Error(`Google geocode failed [${r.status}]`);
  const j = (await r.json()) as {
    places?: Array<{
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    }>;
  };
  return (j.places ?? [])
    .filter((p) => p.location?.latitude != null)
    .map((p) => ({
      name: p.displayName?.text ?? text,
      label: p.formattedAddress ?? p.displayName?.text ?? text,
      lat: p.location!.latitude!,
      lng: p.location!.longitude!,
      source: "Google Places",
    }));
}

async function nominatimGeocode(text: string): Promise<GeoCandidate[]> {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(text)}`,
    { headers: { Accept: "application/json", "User-Agent": "YatraSahayak/1.0" } },
  );
  if (!r.ok) throw new Error(`Nominatim geocode failed [${r.status}]`);
  const j = (await r.json()) as Array<{ display_name?: string; name?: string; lat?: string; lon?: string }>;
  return j
    .filter((x) => x.lat && x.lon)
    .map((x) => ({
      name: x.name ?? x.display_name ?? text,
      label: x.display_name ?? text,
      lat: Number(x.lat),
      lng: Number(x.lon),
      source: "OpenStreetMap",
    }));
}

export const geocodeLocation = createServerFn({ method: "POST" })
  .inputValidator((data) => z.object({ text: z.string().min(1).max(200) }).parse(data))
  .handler(async ({ data }) => {
    const errors: string[] = [];
    for (const step of [geoapifyGeocode, googleGeocode, nominatimGeocode]) {
      try {
        const out = await step(data.text);
        if (out.length) return { candidates: out, errors };
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    return { candidates: [] as GeoCandidate[], errors };
  });

/* ---------------- Place discovery ---------------- */

async function geoapifyPlacesRaw(
  categories: string,
  lat: number,
  lng: number,
  radius: number,
  limit: number,
): Promise<DiscoveredPlace[]> {
  const key = process.env["GEOAPIFY_API_KEY"];
  if (!key) return [];
  const params = new URLSearchParams({
    categories,
    filter: `circle:${lng},${lat},${Math.round(radius)}`,
    bias: `proximity:${lng},${lat}`,
    limit: String(limit),
    apiKey: key,
  });
  const r = await fetch(`https://api.geoapify.com/v2/places?${params.toString()}`);
  if (!r.ok) throw new Error(`Geoapify places failed [${r.status}]`);
  const j = (await r.json()) as {
    features?: Array<{
      properties?: Record<string, unknown> & {
        place_id?: string;
        name?: string;
        formatted?: string;
        city?: string;
        county?: string;
        state?: string;
        country?: string;
        categories?: string[];
        lat?: number;
        lon?: number;
      };
    }>;
  };
  const out: DiscoveredPlace[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties ?? {};
    const name = (p.name ?? "").trim();
    if (!name || typeof p.lat !== "number" || typeof p.lon !== "number") continue;
    const cats = (p.categories ?? []).filter(
      (c) => !c.startsWith("building") && !c.startsWith("wheelchair") && !c.startsWith("internet"),
    );
    const cat = cats.slice().sort((a, b) => b.length - a.length)[0] ?? "attraction";
    const wiki = (p as { datasource?: { raw?: Record<string, unknown> } }).datasource?.raw ?? {};
    const notable = Boolean(wiki["wikidata"] || wiki["wikipedia"] || wiki["heritage"]);
    out.push({
      id: `geoapify:${p.place_id ?? `${name}|${p.lat}|${p.lon}`}`,
      name,
      address: p.formatted ?? "",
      locality: p.city ?? p.county ?? p.state ?? p.country ?? "",
      category: cat.split(".").slice(-1)[0]!.replace(/_/g, " "),
      lat: p.lat,
      lng: p.lon,
      rating: null,
      reviews: null,
      popularity: notable ? 60 : 20,
      source: "Geoapify",
    });
  }
  return out;
}

async function googlePlacesRaw(
  queries: string[],
  lat: number,
  lng: number,
  radius: number,
): Promise<DiscoveredPlace[]> {
  const headers = googleHeaders({
    "X-Goog-FieldMask":
      "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.types",
  });
  if (!headers) return [];
  const out: DiscoveredPlace[] = [];
  for (const q of queries.slice(0, 4)) {
    const r = await fetch(`${GOOGLE_GATEWAY}/places/v1/places:searchText`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        textQuery: q,
        maxResultCount: 20,
        locationBias: {
          circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50000, radius) },
        },
      }),
    });
    if (!r.ok) throw new Error(`Google places failed [${r.status}]`);
    const j = (await r.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        rating?: number;
        userRatingCount?: number;
        primaryTypeDisplayName?: { text?: string };
        types?: string[];
      }>;
    };
    for (const p of j.places ?? []) {
      const name = p.displayName?.text?.trim();
      if (!name || p.location?.latitude == null || p.location?.longitude == null) continue;
      out.push({
        id: `google:${p.id ?? name}`,
        name,
        address: p.formattedAddress ?? "",
        locality: (p.formattedAddress ?? "").split(",").slice(-3, -1).join(",").trim(),
        category:
          p.primaryTypeDisplayName?.text ??
          (p.types ?? [])[0]?.replace(/_/g, " ") ??
          "tourist attraction",
        lat: p.location.latitude,
        lng: p.location.longitude,
        rating: typeof p.rating === "number" ? p.rating : null,
        reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
        popularity: Math.min(100, Math.log10((p.userRatingCount ?? 0) + 1) * 33),
        source: "Google Places",
      });
    }
  }
  return out;
}

async function overpassRaw(lat: number, lng: number, radius: number): Promise<DiscoveredPlace[]> {
  const r = Math.min(50000, Math.round(radius));
  const query = `[out:json][timeout:25];(nwr["tourism"~"attraction|museum|viewpoint|artwork|theme_park|zoo"](around:${r},${lat},${lng});nwr["historic"](around:${r},${lat},${lng});nwr["natural"~"waterfall|peak|beach"](around:${r},${lat},${lng}););out center tags 80;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query,
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  });
  if (!res.ok) throw new Error(`Overpass failed [${res.status}]`);
  const j = (await res.json()) as {
    elements?: Array<{
      id?: number;
      lat?: number;
      lon?: number;
      center?: { lat?: number; lon?: number };
      tags?: Record<string, string>;
    }>;
  };
  const out: DiscoveredPlace[] = [];
  for (const el of j.elements ?? []) {
    const tags = el.tags ?? {};
    const name = (tags["name"] ?? "").trim();
    const plat = el.lat ?? el.center?.lat;
    const plng = el.lon ?? el.center?.lon;
    if (!name || plat == null || plng == null) continue;
    out.push({
      id: `osm:${el.id ?? `${name}|${plat}`}`,
      name,
      address: [tags["addr:street"], tags["addr:city"]].filter(Boolean).join(", "),
      locality: tags["addr:city"] ?? "",
      category: (tags["tourism"] ?? tags["historic"] ?? tags["natural"] ?? "attraction").replace(/_/g, " "),
      lat: plat,
      lng: plng,
      rating: null,
      reviews: null,
      popularity: tags["wikidata"] || tags["wikipedia"] ? 55 : 15,
      source: "OpenStreetMap",
    });
  }
  return out;
}

function mergePlaces(groups: DiscoveredPlace[][]): DiscoveredPlace[] {
  const merged: DiscoveredPlace[] = [];
  const byId = new Set<string>();
  for (const group of groups) {
    for (const p of group) {
      if (byId.has(p.id)) continue;
      const dupe = merged.find(
        (m) => norm(m.name) === norm(p.name) && haversineKm(m.lat, m.lng, p.lat, p.lng) < 0.4,
      );
      if (dupe) {
        dupe.rating = dupe.rating ?? p.rating;
        dupe.reviews = dupe.reviews ?? p.reviews;
        dupe.address = dupe.address || p.address;
        dupe.locality = dupe.locality || p.locality;
        dupe.popularity = Math.max(dupe.popularity, p.popularity);
        if (!dupe.source.includes(p.source)) dupe.source = `${dupe.source} + ${p.source}`;
        continue;
      }
      byId.add(p.id);
      merged.push({ ...p });
    }
  }
  return merged;
}

export const discoverPlaces = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusMeters: z.number().min(1000).max(100000).default(30000),
        categories: z.string().min(3).max(400),
        queries: z.array(z.string().min(2).max(120)).max(4).default([]),
        limit: z.number().min(1).max(100).default(60),
        useOsm: z.boolean().default(true),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const status: Record<string, string> = {};
    const groups: DiscoveredPlace[][] = [];

    try {
      const g = await geoapifyPlacesRaw(
        data.categories,
        data.lat,
        data.lng,
        data.radiusMeters,
        data.limit,
      );
      status["geoapify"] = g.length ? "ok" : "empty";
      groups.push(g);
    } catch (e) {
      status["geoapify"] = `error: ${(e as Error).message}`;
    }

    if (data.queries.length) {
      try {
        const g = await googlePlacesRaw(data.queries, data.lat, data.lng, data.radiusMeters);
        status["google"] = g.length ? "ok" : googleHeaders() ? "empty" : "not configured";
        groups.push(g);
      } catch (e) {
        status["google"] = `error: ${(e as Error).message}`;
      }
    } else {
      status["google"] = "skipped";
    }

    const found = groups.reduce((n, g) => n + g.length, 0);
    if (!found && data.useOsm) {
      try {
        const g = await overpassRaw(data.lat, data.lng, data.radiusMeters);
        status["osm"] = g.length ? "ok" : "empty";
        groups.push(g);
      } catch (e) {
        status["osm"] = `error: ${(e as Error).message}`;
      }
    }

    const places = mergePlaces(groups).map((p) => ({
      ...p,
      distanceKm: Math.round(haversineKm(data.lat, data.lng, p.lat, p.lng) * 100) / 100,
    }));
    places.sort((a, b) => a.distanceKm - b.distanceKm);

    const allFailed = Object.values(status).every((s) => s.startsWith("error") || s === "not configured");
    return { places, status, allFailed };
  });

export const providerStatus = createServerFn({ method: "GET" }).handler(async () => ({
  geoapify: Boolean(process.env["GEOAPIFY_API_KEY"]),
  google: Boolean(process.env["LOVABLE_API_KEY"] && process.env["GOOGLE_MAPS_API_KEY"]),
  osm: true,
}));
