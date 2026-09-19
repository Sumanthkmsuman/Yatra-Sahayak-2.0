/* Places Explorer / Global Tourist Places engine.
   Real providers only: Geoapify (primary), Google Places (secondary),
   OSM/Overpass (bounded fallback). No AI is used for geographic data. */
(function () {
  var CATEGORY_MAP = {
    heritage: "heritage,tourism.sights,building.historic,entertainment.museum",
    religious: "religion.place_of_worship,tourism.sights",
    adventure:
      "entertainment.theme_park,entertainment.activity_park,entertainment.water_park,entertainment.zoo,sport.stadium",
    nature: "leisure.park,natural.forest,national_park,tourism.attraction",
    water: "natural.water,tourism.attraction",
    beach: "beach",
    mountain: "natural.mountain",
    desert: "natural.sand",
    food: "catering.restaurant,catering.cafe",
  };

  var QUERY_MAP = {
    heritage: ["heritage sites and historical monuments", "museums"],
    religious: ["famous temples and places of worship"],
    adventure: ["adventure activities and theme parks"],
    nature: ["parks and nature spots", "famous tourist attractions"],
    water: ["waterfalls and lakes"],
    beach: ["beaches"],
    mountain: ["hills and viewpoints"],
    desert: ["desert and dunes"],
    food: ["popular restaurants"],
  };

  var NEARBY_MAP = {
    hotel: { cats: "accommodation.hotel", q: ["hotels"] },
    restaurant: { cats: "catering.restaurant", q: ["restaurants"] },
    hospital: { cats: "healthcare.hospital", q: ["hospitals"] },
    atm: { cats: "service.financial.atm", q: ["ATM"] },
    fuel: { cats: "service.vehicle.fuel", q: ["petrol pump"] },
    tourism: { cats: "tourism.sights,tourism.attraction", q: ["famous tourist places"] },
  };

  var DEFAULT_CATEGORIES = "tourism.sights,tourism.attraction";
  var RADIUS_OPTIONS = [1, 5, 10, 25, 50, 100];

  var state = {
    places: [],
    center: null,
    label: "",
    origin: "search", // or "gps"
    radiusKm: "all",
    sort: "recommended",
    seq: 0,
  };
  var cache = {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function haversineKm(aLat, aLng, bLat, bLng) {
    var R = 6371,
      dLat = ((bLat - aLat) * Math.PI) / 180,
      dLng = ((bLng - aLng) * Math.PI) / 180;
    var s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((aLat * Math.PI) / 180) *
        Math.cos((bLat * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function activeKeys() {
    return Array.isArray(window.prefsKey) ? window.prefsKey.filter(Boolean) : [];
  }

  function categoriesFor(keys) {
    var picked = (keys || [])
      .map(function (k) {
        return CATEGORY_MAP[k];
      })
      .filter(Boolean);
    if (!picked.length) return DEFAULT_CATEGORIES;
    return picked.join(",").split(",").slice(0, 14).join(",");
  }

  function queriesFor(keys) {
    var out = [];
    (keys || []).forEach(function (k) {
      (QUERY_MAP[k] || []).forEach(function (q) {
        if (out.indexOf(q) < 0) out.push(q);
      });
    });
    if (!out.length) out = ["famous tourist attractions"];
    return out.slice(0, 3);
  }

  function bridge(payload) {
    if (typeof window.yatraPlacesCall !== "function") {
      return Promise.reject(new Error("bridge unavailable"));
    }
    return window.yatraPlacesCall(payload);
  }

  function radiusMetersForRequest() {
    if (state.radiusKm === "all") {
      var mode = "near";
      try {
        mode = (typeof rangeMode !== "undefined" && rangeMode) || window.rangeMode || "near";
      } catch (e) {}
      return mode === "near" ? 30000 : mode === "far" ? 80000 : 100000;
    }
    return Math.min(100000, Number(state.radiusKm) * 1000);
  }

  /* ---------------- location resolution ---------------- */

  function selectedCenter(ids) {
    var sel = window.selectedPlaces || {};
    for (var i = 0; i < ids.length; i++) {
      var p = sel[ids[i]];
      if (p && p.lat != null && p.lng != null) {
        return {
          lat: Number(p.lat),
          lng: Number(p.lng),
          label: p.address || p.name,
          source: "Selected place",
        };
      }
    }
    return null;
  }

  async function resolveCenter(ids, text) {
    var picked = selectedCenter(ids);
    if (picked) return picked;
    if (!text) return null;
    try {
      var res = await bridge({ kind: "geocode", text: text });
      var c = (res.candidates || [])[0];
      if (c) {
        window.currentGlobalLocation = { lat: c.lat, lon: c.lng, display_name: c.label };
        return { lat: c.lat, lng: c.lng, label: c.label, source: c.source };
      }
    } catch (e) {}
    if (typeof window.geocodeAnyGlobalLocation === "function") {
      var geo = await window.geocodeAnyGlobalLocation(text);
      if (geo && isFinite(Number(geo.lat))) {
        return {
          lat: Number(geo.lat),
          lng: Number(geo.lon),
          label: geo.display_name || text,
          source: "OpenStreetMap",
        };
      }
    }
    return null;
  }

  /* ---------------- rendering ---------------- */

  function filtered() {
    var list = state.places.slice();
    if (state.radiusKm !== "all") {
      var lim = Number(state.radiusKm);
      list = list.filter(function (p) {
        return p.distanceKm <= lim;
      });
    }
    var s = state.sort;
    list.sort(function (a, b) {
      if (s === "nearest") return a.distanceKm - b.distanceKm;
      if (s === "farthest") return b.distanceKm - a.distanceKm;
      if (s === "popular") return (b.reviews || 0) - (a.reviews || 0);
      if (s === "rated") return (b.rating || 0) - (a.rating || 0);
      return score(b) - score(a);
    });
    return list;
  }

  function score(p) {
    var rating = p.rating ? (p.rating - 3) * 18 : 0;
    var reviews = p.reviews ? Math.log10(p.reviews + 1) * 22 : 0;
    var pop = (p.popularity || 0) * 0.5;
    var near = Math.max(0, 30 - p.distanceKm) * 0.9;
    return rating + reviews + pop + near;
  }

  function controlsHtml(total, shown) {
    var radii = ['<button type="button" class="btn' +
      (state.radiusKm === "all" ? " gold" : " gray") +
      '" data-radius="all">All</button>'];
    RADIUS_OPTIONS.forEach(function (km) {
      radii.push(
        '<button type="button" class="btn' +
          (String(state.radiusKm) === String(km) ? " gold" : " gray") +
          '" data-radius="' +
          km +
          '">' +
          km +
          " km</button>"
      );
    });
    var sorts = [
      ["recommended", "Recommended"],
      ["nearest", "Nearest"],
      ["farthest", "Farthest"],
      ["popular", "Most popular"],
      ["rated", "Highest rated"],
    ]
      .map(function (o) {
        return (
          '<option value="' +
          o[0] +
          '"' +
          (state.sort === o[0] ? " selected" : "") +
          ">" +
          o[1] +
          "</option>"
        );
      })
      .join("");

    return (
      '<div class="success"><b>📍 ' +
      (state.origin === "gps" ? "Your GPS location" : "Searched location") +
      ":</b> " +
      esc(state.label) +
      "<br><span class=\"small\">" +
      shown +
      " of " +
      total +
      " real places from live providers — distances measured from this point.</span></div>" +
      '<div id="pxControls" class="linkrow" style="flex-wrap:wrap;gap:6px;margin:10px 0">' +
      radii.join("") +
      '<select id="pxSort" class="btn gray" style="min-width:150px">' +
      sorts +
      "</select></div>" +
      '<div id="pxMap" style="height:320px;border-radius:14px;overflow:hidden;margin:10px 0;border:1px solid #e4ddc9"></div>'
    );
  }

  function cardHtml(p, i) {
    var dist =
      p.distanceKm < 1
        ? Math.round(p.distanceKm * 1000) + " m"
        : p.distanceKm.toFixed(1) + " km";
    var rating = p.rating
      ? "⭐ " + p.rating + "/5" + (p.reviews ? " (" + p.reviews + " reviews)" : "")
      : "⭐ Rating not published by the source";
    return (
      '<div class="place" id="place' +
      i +
      '"><div class="row"><div><span class="badge">' +
      esc(p.source) +
      "</span><h3>" +
      esc(p.name) +
      '</h3></div><div class="price">' +
      esc(dist) +
      '</div></div><div class="muted">📍 ' +
      esc(p.address || p.locality || state.label) +
      "<br>🏷️ " +
      esc(p.category || "tourist attraction") +
      "<br>" +
      esc(rating) +
      '</div><br><a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(p.lat + "," + p.lng) +
      '">📍 Location</a> <button type="button" class="btn gold" data-action="add-plan" data-index="' +
      i +
      '">➕ Add to plan</button></div>'
    );
  }

  function render() {
    var list = filtered();
    var h = controlsHtml(state.places.length, list.length);
    if (!list.length) {
      h +=
        '<div class="warn">ℹ️ <b>No places within this distance filter.</b><br>Try a larger distance or another category.</div>';
    }
    list.forEach(function (p, i) {
      h += cardHtml(p, i);
    });

    window.globalTouristResults = list.map(function (p) {
      return [
        p.name,
        p.locality || state.label,
        p.category,
        p.distanceKm <= 30 ? "near" : "far",
        0,
        p.rating ? String(p.rating) : "Live",
        p.lat,
        p.lng,
        p.distanceKm,
      ];
    });
    window.placeResults = window.globalTouristResults;
    try {
      placeResults = window.placeResults;
    } catch (e) {}

    if (typeof window.placesDiv === "function") window.placesDiv(h);
    wireControls();
    drawMap(list);
  }

  function wireControls() {
    var box = document.getElementById("pxControls");
    if (!box) return;
    box.querySelectorAll("[data-radius]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.radiusKm = b.getAttribute("data-radius");
        render();
      });
    });
    var sel = document.getElementById("pxSort");
    if (sel)
      sel.addEventListener("change", function () {
        state.sort = sel.value;
        render();
      });
  }

  /* ---------------- map ---------------- */

  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    if (window._pxLeaflet) return window._pxLeaflet;
    window._pxLeaflet = new Promise(function (resolve, reject) {
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(css);
      var s = document.createElement("script");
      s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window._pxLeaflet;
  }

  function drawMap(list) {
    var el = document.getElementById("pxMap");
    if (!el || !state.center) return;
    ensureLeaflet()
      .then(function () {
        var map = window.L.map(el).setView([state.center.lat, state.center.lng], 11);
        window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap",
          maxZoom: 18,
        }).addTo(map);
        var pts = [[state.center.lat, state.center.lng]];
        window.L.marker([state.center.lat, state.center.lng])
          .addTo(map)
          .bindPopup(
            "<b>" +
              esc(state.label) +
              "</b><br>" +
              (state.origin === "gps" ? "Your GPS location" : "Searched location")
          );
        list.forEach(function (p) {
          pts.push([p.lat, p.lng]);
          window.L.marker([p.lat, p.lng])
            .addTo(map)
            .bindPopup(
              "<b>" +
                esc(p.name) +
                "</b><br>" +
                p.distanceKm.toFixed(1) +
                " km away<br>" +
                esc(p.address || p.locality || "") +
                "<br>" +
                (p.rating ? "⭐ " + p.rating + "/5" : "Rating not published") +
                "<br><i>Source: " +
                esc(p.source) +
                "</i>"
            );
        });
        map.fitBounds(window.L.latLngBounds(pts).pad(0.15));
        setTimeout(function () {
          map.invalidateSize();
        }, 200);
      })
      .catch(function () {});
  }

  /* ---------------- discovery flow ---------------- */

  function loading(label, categoryText) {
    if (typeof window.placesDiv !== "function") return;
    window.placesDiv(
      '<div class="success">🔎 <b>Searching real ' +
        esc(categoryText) +
        " places near " +
        esc(label) +
        "…</b><br><span class=\"small muted\">Live provider search in progress.</span></div>"
    );
  }

  async function discover(opts) {
    var keys = activeKeys();
    var categoryText = keys.length ? keys.join(" / ") : "tourist";
    var seq = ++state.seq;

    loading(opts.text || "your location", categoryText);

    var center = opts.center || null;
    if (!center) {
      try {
        center = await resolveCenter(opts.fieldIds || [], opts.text);
      } catch (e) {
        center = null;
      }
    }
    if (seq !== state.seq) return;
    if (!center) {
      if (typeof window.placesDiv === "function") {
        window.placesDiv(
          '<div class="warn">📍 <b>We could not place "' +
            esc(opts.text) +
            '" on the map.</b><br>Start typing the location again and pick one of the suggestions — spelling variants are matched by the map providers.</div>'
        );
      }
      return;
    }

    state.center = center;
    state.origin = opts.origin || "search";
    state.label = center.label || opts.text || "your location";
    window.globalSearchName = state.label;

    var radius = radiusMetersForRequest();
    var cats = opts.categories || categoriesFor(keys);
    var queries = opts.queries || queriesFor(keys);
    var cacheKey = [
      center.lat.toFixed(3),
      center.lng.toFixed(3),
      radius,
      cats,
      queries.join("|"),
    ].join("::");

    var cached = cache[cacheKey];
    if (cached && Date.now() - cached.t < 5 * 60 * 1000) {
      state.places = cached.places;
      render();
      updateCityPanel(cached.places.length);
      return;
    }

    var result;
    try {
      result = await bridge({
        kind: "discover",
        categories: cats,
        queries: queries,
        lat: center.lat,
        lng: center.lng,
        radiusMeters: radius,
        limit: 60,
      });
    } catch (e) {
      if (seq !== state.seq) return;
      if (typeof window.placesDiv === "function") {
        window.placesDiv(
          '<div class="warn">⚠️ <b>All map providers are unavailable right now.</b><br>Please check your internet connection and try again in a moment. No results are shown because we never guess place data.</div>'
        );
      }
      return;
    }
    if (seq !== state.seq) return;

    var places = (result.places || []).filter(function (p) {
      return p && p.name && isFinite(p.lat) && isFinite(p.lng);
    });
    places.forEach(function (p) {
      p.distanceKm = haversineKm(center.lat, center.lng, p.lat, p.lng);
    });
    var maxKm = (radius / 1000) * 1.1;
    places = places.filter(function (p) {
      return p.distanceKm <= maxKm;
    });

    if (!places.length) {
      if (typeof window.placesDiv === "function") {
        window.placesDiv(
          '<div class="warn">ℹ️ <b>No ' +
            esc(categoryText) +
            " places found near " +
            esc(state.label) +
            ".</b><br>Try a bigger distance, another category, or a nearby larger town.</div>"
        );
      }
      state.places = [];
      return;
    }

    cache[cacheKey] = { t: Date.now(), places: places };
    state.places = places;
    render();
    updateCityPanel(places.length);
  }

  function updateCityPanel(n) {
    var count = document.getElementById("cityPlaceCount");
    var note = document.getElementById("cityNote");
    var detected = document.getElementById("cityDetected");
    if (count) count.textContent = String(n);
    if (note) note.innerHTML = "✅ <b>Location found:</b> " + esc(state.label);
    if (detected) {
      detected.classList.remove("hidden");
      detected.textContent = "✓ " + state.label;
    }
  }

  var debounceTimer = null;
  function debounced(fn) {
    return function () {
      var args = arguments,
        self = this;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        fn.apply(self, args);
      }, 250);
    };
  }

  /* ---------------- settings / provider status ---------------- */

  async function renderSettings() {
    var host = document.getElementById("pxSettings");
    if (!host) return;
    var providers = { geoapify: false, google: false, osm: true };
    try {
      var res = await bridge({ kind: "status" });
      providers = res.providers || providers;
    } catch (e) {}
    function row(name, ok, hint) {
      return (
        '<div class="muted small">' +
        (ok ? "✅ " : "⚠️ ") +
        "<b>" +
        name +
        "</b> — " +
        (ok ? "configured and in use" : hint) +
        "</div>"
      );
    }
    host.innerHTML =
      '<div class="card"><h3>🔌 Place data providers</h3>' +
      row("Geoapify (primary)", providers.geoapify, "add the GEOAPIFY_API_KEY secret to enable") +
      row("Google Places (secondary)", providers.google, "connect Google Maps to enable") +
      row("OpenStreetMap (fallback)", true, "") +
      '<div class="muted small" style="margin-top:8px">Keys are stored as encrypted server secrets and are never included in this page. To add or change a key, use your project settings → secrets/connectors.</div></div>';
  }

  /* ---------------- install ---------------- */

  function install() {
    if (typeof window.placesDiv !== "function") return false;

    window.discoverAnyLocationPlaces = debounced(function () {
      var text = ((document.getElementById("cityChoice") || {}).value || "").trim();
      if (!text && !selectedCenter(["cityChoice", "loc_city"])) {
        alert("Please type your city, town or village first.");
        return;
      }
      discover({ text: text, fieldIds: ["cityChoice", "loc_city"] });
    });

    window.aiDiscoverPlaces = debounced(function () {
      var dest = ((document.getElementById("dest") || {}).value || "").trim();
      var country = ((document.getElementById("travelCountry") || {}).value || "").trim();
      var text = dest ? dest + (country ? ", " + country : "") : country;
      if (!text && !selectedCenter(["dest"])) {
        alert("Please select a country or type a destination first.");
        return;
      }
      discover({ text: text, fieldIds: ["dest"] });
    });

    window.renderGlobalTouristResults = function () {
      if (state.places.length) render();
    };

    window.findNearbyPlaces = function (category) {
      var status = document.getElementById("nearbyStatus");
      var box = document.getElementById("nearbyResults");
      if (!status || !box) return;
      box.innerHTML = "";
      if (!navigator.geolocation) {
        status.textContent = "❌ Location is not supported by this browser.";
        return;
      }
      status.textContent = "📍 Asking for permission to use your GPS location…";
      navigator.geolocation.getCurrentPosition(
        async function (pos) {
          status.textContent = "🔎 Searching nearby " + category + " using your GPS location…";
          var conf = NEARBY_MAP[category] || { cats: DEFAULT_CATEGORIES, q: ["tourist places"] };
          try {
            var res = await bridge({
              kind: "discover",
              categories: conf.cats,
              queries: conf.q,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              radiusMeters: 15000,
              limit: 30,
            });
            var places = (res.places || []).map(function (p) {
              p.distanceKm = haversineKm(
                pos.coords.latitude,
                pos.coords.longitude,
                p.lat,
                p.lng
              );
              return p;
            });
            places.sort(function (a, b) {
              return a.distanceKm - b.distanceKm;
            });
            if (!places.length) {
              status.textContent = "ℹ️ No nearby results found. Try another category.";
              return;
            }
            var icon =
              {
                hotel: "🏨",
                restaurant: "🍽️",
                hospital: "🏥",
                atm: "🏧",
                fuel: "⛽",
                tourism: "🗺️",
              }[category] || "📍";
            status.innerHTML =
              "📍 Found <b>" +
              places.length +
              "</b> result(s) around <b>your GPS location</b>.";
            box.innerHTML = places
              .slice(0, 12)
              .map(function (x) {
                return (
                  '<div class="nearby-item"><span style="font-size:22px">' +
                  icon +
                  '</span><div class="grow"><b>' +
                  esc(x.name) +
                  '</b><div class="muted small">' +
                  esc(x.address || x.locality || "Nearby") +
                  " • " +
                  x.distanceKm.toFixed(1) +
                  " km • " +
                  esc(x.source) +
                  "</div></div>" +
                  '<button class="btn" onclick="openNearbyMap(' +
                  x.lat +
                  "," +
                  x.lng +
                  ')">Map</button></div>'
                );
              })
              .join("");
          } catch (e) {
            status.innerHTML =
              "⚠️ All nearby place providers are unavailable right now. Please check your connection and try again.";
          }
        },
        function () {
          status.textContent = "❌ GPS permission is needed to search around you.";
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    };

    renderSettings();
    return true;
  }

  function boot() {
    if (install()) return;
    var tries = 0;
    var timer = setInterval(function () {
      if (install() || ++tries > 40) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
