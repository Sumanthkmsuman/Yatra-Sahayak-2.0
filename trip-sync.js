/* Keeps source + destination in sync across the app and feeds the Live Journey Assistant. */
(function () {
  var KEY = "ysTripSync";

  function readStore() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  var store = readStore();

  function writeStore() {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch (e) {}
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function chosen(id) {
    var p = (window.selectedPlaces || {})[id];
    return p && p.name ? String(p.name).trim() : "";
  }

  function sourceName() {
    return (
      val("start") ||
      chosen("start") ||
      store.start ||
      val("loc_city") ||
      chosen("loc_city") ||
      (window.profile && window.profile.city) ||
      ""
    );
  }

  function destinationName() {
    var cityMode = window.mode === "city";
    var explorer = val("cityChoice") || chosen("cityChoice");
    var planner = val("dest") || chosen("dest");
    if (cityMode) return explorer || planner || store.dest || "";
    return planner || explorer || store.dest || "";
  }

  function fillIfEmpty(id, value) {
    if (!value) return;
    var el = document.getElementById(id);
    if (!el || String(el.value || "").trim()) return;
    el.value = value;
  }

  /* Adds "Journey from" / "Journey to" rows to the existing journey card. */
  function ensureJourneyRows() {
    var anchor = document.getElementById("journeyLocation");
    if (!anchor || document.getElementById("journeyFrom")) return;
    var grid = anchor.closest(".travel-stat-grid");
    if (!grid) return;
    var from = document.createElement("div");
    from.className = "travel-stat";
    from.innerHTML =
      '<span class="small">Journey from</span><b id="journeyFrom">Not selected</b>';
    var to = document.createElement("div");
    to.className = "travel-stat";
    to.innerHTML =
      '<span class="small">Journey to</span><b id="journeyTo">Not selected</b>';
    grid.insertBefore(from, grid.firstChild);
    grid.insertBefore(to, from.nextSibling);
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function sync() {
    var from = sourceName();
    var to = destinationName();

    if (from) {
      store.start = from;
      window.currentStart = from;
    }
    if (to) {
      store.dest = to;
      window.currentCity = to;
    }
    if (from || to) writeStore();

    fillIfEmpty("start", store.start);
    fillIfEmpty("dest", store.dest);
    fillIfEmpty("cityChoice", store.dest);

    ensureJourneyRows();
    setText("journeyFrom", store.start || "Not selected");
    setText("journeyTo", store.dest || "Not selected");
  }


  window.yatraTripSync = sync;
  window.yatraTripSource = sourceName;
  window.yatraTripDestination = destinationName;

  document.addEventListener("input", function (e) {
    var id = e.target && e.target.id;
    if (id === "start" || id === "dest" || id === "cityChoice" || id === "loc_city") sync();
  });
  document.addEventListener("change", function (e) {
    var id = e.target && e.target.id;
    if (id === "start" || id === "dest" || id === "cityChoice" || id === "loc_city") sync();
  });
  document.addEventListener("click", function () {
    setTimeout(sync, 60);
  });

  var coordCache = {};

  function install() {
    /* Resolve place coordinates through the app's own provider bridge first. */
    var originalCoords = window.getTrackingCoords;
    if (typeof originalCoords === "function" && !originalCoords.__tsPatched) {
      var patchedCoords = async function (place) {
        var name = Array.isArray(place) ? place[0] : (place && place.name) || "";
        var city = Array.isArray(place) ? place[1] : "";
        var label = String(name || "").trim();
        if (label) {
          var picked = window.selectedPlaces || {};
          var keys = Object.keys(picked);
          for (var i = 0; i < keys.length; i++) {
            var p = picked[keys[i]];
            if (p && p.lat != null && String(p.name).toLowerCase() === label.toLowerCase()) {
              return { name: label, coords: [Number(p.lat), Number(p.lng)], source: "selected" };
            }
          }
          var cacheKey = (label + "|" + (city || "")).toLowerCase();
          if (coordCache[cacheKey]) return coordCache[cacheKey];
          if (typeof window.yatraPlacesCall === "function") {
            try {
              var res = await window.yatraPlacesCall({
                kind: "geocode",
                text: label + (city ? ", " + city : ""),
              });
              var top = res && res.candidates && res.candidates[0];
              if (top && top.lat != null && top.lng != null) {
                var out = {
                  name: label,
                  coords: [Number(top.lat), Number(top.lng)],
                  source: "map",
                };
                coordCache[cacheKey] = out;
                return out;
              }
            } catch (e) {}
          }
        }
        try {
          return await originalCoords.apply(this, arguments);
        } catch (e) {
          return null;
        }
      };
      patchedCoords.__tsPatched = true;
      window.getTrackingCoords = patchedCoords;
    }

    /* Journey assistant can run on the chosen destination even before a trip is saved. */

    var originalPlaces = window.getTravellerPlaces;
    if (typeof originalPlaces === "function" && !originalPlaces.__tsPatched) {
      var patchedPlaces = function () {
        var list = [];
        try {
          list = originalPlaces.apply(this, arguments) || [];
        } catch (e) {
          list = [];
        }
        if (list.length) return list;
        var to = destinationName();
        return to ? [[to, "", "", "", 0]] : [];
      };
      patchedPlaces.__tsPatched = true;
      window.getTravellerPlaces = patchedPlaces;
    }

    var originalStart = window.startJourneyAssistant;
    if (typeof originalStart === "function" && !originalStart.__tsPatched) {
      var patchedStart = function () {
        sync();
        var status = document.getElementById("journeyStatus");
        if (!destinationName() && !(window.getTravellerPlaces() || []).length) {
          if (status)
            status.innerHTML =
              "⚠️ <b>Choose a destination first.</b><br>Type or select where you are going, then start again.";
          return;
        }
        var out = originalStart.apply(this, arguments);
        /* Refresh once GPS + geocoding have had time to resolve. */
        [3000, 8000].forEach(function (ms) {
          setTimeout(function () {
            try {
              if (typeof window.updateJourneyAssistant === "function") window.updateJourneyAssistant();
            } catch (e) {}
          }, ms);
        });
        return out;
      };
      patchedStart.__tsPatched = true;
      window.startJourneyAssistant = patchedStart;
    }

    var originalRoute = window.openCurrentRouteInMaps;
    if (typeof originalRoute === "function" && !originalRoute.__tsPatched) {
      var patchedRoute = function () {
        sync();
        if (window.journeyCurrentPosition) return originalRoute.apply(this, arguments);
        var from = sourceName();
        var to = destinationName();
        if (!to) {
          alert("Choose a destination first, or start the journey assistant to use live GPS.");
          return;
        }
        var url =
          "https://www.google.com/maps/dir/?api=1" +
          (from ? "&origin=" + encodeURIComponent(from) : "") +
          "&destination=" +
          encodeURIComponent(to) +
          "&travelmode=driving";
        window.open(url, "_blank");
      };
      patchedRoute.__tsPatched = true;
      window.openCurrentRouteInMaps = patchedRoute;
    }
  }

  function boot() {
    sync();
    install();
    setInterval(function () {
      sync();
      install();
    }, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
