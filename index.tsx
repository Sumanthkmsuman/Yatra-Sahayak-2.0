import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { placeAutocomplete, placeDetails, geoapifyPlaces } from "@/lib/places.functions";
import { discoverPlaces, geocodeLocation, providerStatus } from "@/lib/discovery.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Yatra Sahayak | Complete Travel Companion" },
      {
        name: "description",
        content:
          "Plan trips, discover live nearby places, track budgets and stay safe with Yatra Sahayak, your all-in-one travel companion.",
      },
      { property: "og:title", content: "Yatra Sahayak | Complete Travel Companion" },
      {
        property: "og:description",
        content:
          "Plan trips, discover live nearby places, track budgets and stay safe with Yatra Sahayak.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type PlacesRequest = {
  source: "yatra-places";
  id: string;
  kind: "autocomplete" | "details" | "geoapify" | "discover" | "geocode" | "status";
  text?: string;
  queries?: string[];
  useOsm?: boolean;
  input?: string;
  placeId?: string;
  sessionToken?: string;
  categories?: string;
  lat?: number;
  lng?: number;
  radiusMeters?: number;
  limit?: number;
};

function Index() {
  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      const data = event.data as PlacesRequest | undefined;
      if (!data || data.source !== "yatra-places" || event.origin !== window.location.origin) {
        return;
      }
      const reply = (payload: Record<string, unknown>) =>
        (event.source as Window | null)?.postMessage(
          { source: "yatra-places-reply", id: data.id, ...payload },
          window.location.origin,
        );

      try {
        if (data.kind === "autocomplete") {
          const suggestions = await placeAutocomplete({
            data: { input: data.input ?? "", sessionToken: data.sessionToken },
          });
          reply({ ok: true, suggestions });
        } else if (data.kind === "geoapify") {
          const places = await geoapifyPlaces({
            data: {
              categories: data.categories ?? "tourism.sights",
              lat: Number(data.lat),
              lng: Number(data.lng),
              radiusMeters: Number(data.radiusMeters) || 20000,
              limit: Number(data.limit) || 40,
            },
          });
          reply({ ok: true, places });
        } else if (data.kind === "discover") {
          const result = await discoverPlaces({
            data: {
              categories: data.categories ?? "tourism.sights,tourism.attraction",
              queries: (data.queries ?? []).slice(0, 4),
              lat: Number(data.lat),
              lng: Number(data.lng),
              radiusMeters: Number(data.radiusMeters) || 30000,
              limit: Number(data.limit) || 60,
              useOsm: data.useOsm !== false,
            },
          });
          reply({ ok: true, ...result });
        } else if (data.kind === "geocode") {
          const result = await geocodeLocation({ data: { text: data.text ?? "" } });
          reply({ ok: true, ...result });
        } else if (data.kind === "status") {
          const providers = await providerStatus();
          reply({ ok: true, providers });
        } else {
          const place = await placeDetails({
            data: { placeId: data.placeId ?? "", sessionToken: data.sessionToken },
          });
          reply({ ok: true, place });
        }
      } catch (error) {
        reply({ ok: false, error: (error as Error).message });
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <main className="h-screen w-screen">
      <h1 className="sr-only">Yatra Sahayak travel companion</h1>
      <iframe
        title="Yatra Sahayak travel companion"
        src="/yatra.html"
        className="h-full w-full border-0"
        allow="geolocation *; clipboard-write"
      />
    </main>
  );
}
