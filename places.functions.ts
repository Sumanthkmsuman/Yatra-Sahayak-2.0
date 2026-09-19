import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_maps";

function gatewayHeaders(extra: Record<string, string> = {}) {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const mapsKey = process.env["GOOGLE_MAPS_API_KEY"];
  if (!lovableKey || !mapsKey) throw new Error("Google Maps connection is not configured");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": mapsKey,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function readError(response: Response) {
  const body = await response.text();
  console.error(`Places gateway failed [${response.status}]: ${body}`);
  throw new Error(`Places request failed [${response.status}]`);
}

export const placeAutocomplete = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        input: z.string().min(2).max(120),
        sessionToken: z.string().min(1).max(64).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const response = await fetch(`${GATEWAY_URL}/places/v1/places:autocomplete`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({
        input: data.input,
        sessionToken: data.sessionToken,
      }),
    });
    if (!response.ok) await readError(response);
    const json = (await response.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };
    return (json.suggestions ?? [])
      .filter((s) => s.placePrediction?.placeId)
      .slice(0, 6)
      .map((s) => ({
        placeId: s.placePrediction!.placeId!,
        text: s.placePrediction!.text?.text ?? "",
        mainText: s.placePrediction!.structuredFormat?.mainText?.text ?? "",
        secondaryText: s.placePrediction!.structuredFormat?.secondaryText?.text ?? "",
      }));
  });

export const placeDetails = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        placeId: z.string().min(1).max(200),
        sessionToken: z.string().min(1).max(64).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const query = data.sessionToken
      ? `?sessionToken=${encodeURIComponent(data.sessionToken)}`
      : "";
    const response = await fetch(
      `${GATEWAY_URL}/places/v1/places/${encodeURIComponent(data.placeId)}${query}`,
      {
        headers: gatewayHeaders({
          "X-Goog-FieldMask": "id,displayName,formattedAddress,location",
        }),
      },
    );
    if (!response.ok) await readError(response);
    const json = (await response.json()) as {
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };
    return {
      id: json.id ?? data.placeId,
      name: json.displayName?.text ?? "",
      address: json.formattedAddress ?? "",
      lat: json.location?.latitude ?? null,
      lng: json.location?.longitude ?? null,
    };
  });

export const geoapifyPlaces = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        categories: z.string().min(3).max(300),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusMeters: z.number().min(500).max(100000).default(20000),
        limit: z.number().min(1).max(100).default(40),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const key = process.env["GEOAPIFY_API_KEY"];
    if (!key) throw new Error("Geoapify API key is not configured");

    const params = new URLSearchParams({
      categories: data.categories,
      filter: `circle:${data.lng},${data.lat},${Math.round(data.radiusMeters)}`,
      bias: `proximity:${data.lng},${data.lat}`,
      limit: String(data.limit),
      apiKey: key,
    });

    const response = await fetch(`https://api.geoapify.com/v2/places?${params.toString()}`);
    if (!response.ok) {
      const body = await response.text();
      console.error(`Geoapify places failed [${response.status}]: ${body}`);
      throw new Error(`Geoapify request failed [${response.status}]`);
    }

    const json = (await response.json()) as {
      features?: Array<{
        properties?: {
          place_id?: string;
          name?: string;
          address_line1?: string;
          address_line2?: string;
          formatted?: string;
          city?: string;
          county?: string;
          state?: string;
          country?: string;
          categories?: string[];
          distance?: number;
          lat?: number;
          lon?: number;
        };
      }>;
    };

    const seen = new Set<string>();
    const places: Array<{
      id: string;
      name: string;
      address: string;
      locality: string;
      category: string;
      distanceKm: number | null;
      lat: number | null;
      lng: number | null;
    }> = [];

    for (const f of json.features ?? []) {
      const p = f.properties ?? {};
      const name = (p.name ?? "").trim();
      if (!name) continue;
      const id = p.place_id ?? `${name}|${p.lat}|${p.lon}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const cats = (p.categories ?? []).filter(
        (c) => !c.startsWith("building") && !c.startsWith("wheelchair") && !c.startsWith("internet"),
      );
      const category =
        cats.slice().sort((a, b) => b.length - a.length)[0] ?? "attraction";
      places.push({
        id,
        name,
        address: p.formatted ?? p.address_line2 ?? "",
        locality: p.city ?? p.county ?? p.state ?? p.country ?? "",
        category: category.split(".").slice(-1)[0]!.replace(/_/g, " "),
        distanceKm:
          typeof p.distance === "number" ? Math.round((p.distance / 1000) * 10) / 10 : null,
        lat: typeof p.lat === "number" ? p.lat : null,
        lng: typeof p.lon === "number" ? p.lon : null,
      });
    }

    places.sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
    return places;
  });
