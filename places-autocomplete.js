/* Google Places (New) autocomplete for Yatra Sahayak location fields. */
(function () {
  var FIELDS = [
    { id: "loc_city", label: "Current city" },
    { id: "cityChoice", label: "Your city" },
    { id: "start", label: "Current location" },
    { id: "dest", label: "Destination" },
  ];

  window.selectedPlaces = window.selectedPlaces || {};

  var style = document.createElement("style");
  style.textContent =
    ".gp-wrap{position:relative}" +
    ".gp-list{position:absolute;z-index:9999;left:0;right:0;top:100%;margin-top:4px;background:#fffdf8;border:1px solid #e4ddc9;border-radius:12px;box-shadow:0 12px 30px rgba(30,58,95,.18);max-height:280px;overflow:auto}" +
    ".gp-list.hidden{display:none}" +
    ".gp-item{padding:10px 12px;cursor:pointer;border-bottom:1px solid #f1ead9}" +
    ".gp-item:last-child{border-bottom:0}" +
    ".gp-item:hover,.gp-item.active{background:#f6f3ea}" +
    ".gp-main{font-weight:700;color:#1e3a5f;font-size:14px}" +
    ".gp-sec{font-size:12px;color:#64748b}" +
    ".gp-chip{display:none;align-items:center;gap:8px;margin-top:6px;padding:7px 10px;border-radius:999px;background:#e9f7ef;color:#256044;font-size:12px;font-weight:700}" +
    ".gp-chip.show{display:inline-flex}" +
    ".gp-chip button{border:0;background:transparent;color:#256044;font-weight:800;cursor:pointer;font-size:13px}" +
    ".gp-note{font-size:12px;color:#8c2f39;margin-top:5px;display:none}" +
    ".gp-note.show{display:block}";
  document.head.appendChild(style);

  var pending = {};
  var reqSeq = 0;

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source !== "yatra-places-reply") return;
    var cb = pending[d.id];
    if (!cb) return;
    delete pending[d.id];
    cb(d);
  });

  function callPlaces(payload) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) return reject(new Error("no host"));
      var id = "r" + ++reqSeq;
      pending[id] = function (res) {
        if (res.ok) resolve(res);
        else reject(new Error(res.error || "failed"));
      };
      window.parent.postMessage(
        Object.assign({ source: "yatra-places", id: id }, payload),
        "*"
      );
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error("timeout"));
        }
      }, payload && payload.kind === "discover" ? 45000 : 15000);
    });
  }

  /* Shared bridge so other scripts (category discovery) can reach the server. */
  window.yatraPlacesCall = callPlaces;

  function newToken() {
    return "s" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments,
        self = this;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(self, a);
      }, ms);
    };
  }

  function attach(field) {
    var input = document.getElementById(field.id);
    if (!input || input.dataset.gpBound) return;
    input.dataset.gpBound = "1";
    input.setAttribute("autocomplete", "off");

    var wrap = document.createElement("div");
    wrap.className = "gp-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var list = document.createElement("div");
    list.className = "gp-list hidden";
    wrap.appendChild(list);

    var chip = document.createElement("div");
    chip.className = "gp-chip";
    wrap.parentNode.insertBefore(chip, wrap.nextSibling);

    var note = document.createElement("div");
    note.className = "gp-note";
    wrap.parentNode.insertBefore(note, chip.nextSibling);

    var token = null;
    var items = [];
    var activeIndex = -1;

    function hide() {
      list.classList.add("hidden");
      activeIndex = -1;
    }

    function clearSelection() {
      delete window.selectedPlaces[field.id];
      chip.classList.remove("show");
      chip.innerHTML = "";
    }

    function showSelection(place) {
      window.selectedPlaces[field.id] = place;
      chip.innerHTML =
        "<span>📍 Selected: " +
        place.name.replace(/</g, "&lt;") +
        "</span>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "✕ change";
      btn.onclick = function () {
        clearSelection();
        input.value = "";
        input.focus();
      };
      chip.appendChild(btn);
      chip.classList.add("show");
    }

    function render() {
      if (!items.length) return hide();
      list.innerHTML = "";
      items.forEach(function (s, i) {
        var row = document.createElement("div");
        row.className = "gp-item" + (i === activeIndex ? " active" : "");
        row.innerHTML = '<div class="gp-main"></div><div class="gp-sec"></div>';
        row.querySelector(".gp-main").textContent = s.mainText || s.text;
        row.querySelector(".gp-sec").textContent = s.secondaryText || "";
        row.addEventListener("mousedown", function (e) {
          e.preventDefault();
          choose(i);
        });
        list.appendChild(row);
      });
      list.classList.remove("hidden");
    }

    async function choose(i) {
      var s = items[i];
      if (!s) return;
      hide();
      input.value = s.mainText || s.text;
      try {
        var res = await callPlaces({
          kind: "details",
          placeId: s.placeId,
          sessionToken: token,
        });
        var place = res.place || {};
        showSelection({
          id: place.id || s.placeId,
          name: place.name || s.mainText || s.text,
          address: place.address || s.text,
          lat: place.lat,
          lng: place.lng,
        });
        if (place.name) input.value = place.name;
      } catch (e) {
        showSelection({
          id: s.placeId,
          name: s.mainText || s.text,
          address: s.text,
          lat: null,
          lng: null,
        });
      }
      token = null;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    var search = debounce(async function () {
      var value = input.value.trim();
      if (value.length < 2) return hide();
      try {
        if (!token) token = newToken();
        var res = await callPlaces({
          kind: "autocomplete",
          input: value,
          sessionToken: token,
        });
        items = res.suggestions || [];
        note.classList.remove("show");
        render();
      } catch (e) {
        items = [];
        hide();
        note.textContent = "Place suggestions are unavailable right now.";
        note.classList.add("show");
      }
    }, 250);

    input.addEventListener("input", function (e) {
      if (!e.isTrusted) return;
      var sel = window.selectedPlaces[field.id];
      if (sel && input.value.trim() !== sel.name && input.value.trim() !== sel.address) {
        clearSelection();
      }
      search();
    });
    input.addEventListener("focus", function () {
      if (items.length && input.value.trim().length >= 2) render();
    });
    input.addEventListener("blur", function () {
      setTimeout(hide, 120);
    });
    input.addEventListener("keydown", function (e) {
      if (list.classList.contains("hidden")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
      } else if (e.key === "Enter") {
        if (activeIndex >= 0) {
          e.preventDefault();
          choose(activeIndex);
        }
      } else if (e.key === "Escape") {
        hide();
      }
    });
  }

  function attachAll() {
    FIELDS.forEach(attach);
  }

  /* Let the existing app reuse coordinates from a selected suggestion. */
  function patchGeocoder() {
    var original = window.geocodeAnyGlobalLocation;
    if (typeof original !== "function" || original.__gpPatched) return;
    var patched = async function (name, countryHint) {
      var raw = String(name || "").trim().toLowerCase();
      var keys = Object.keys(window.selectedPlaces || {});
      for (var i = 0; i < keys.length; i++) {
        var p = window.selectedPlaces[keys[i]];
        if (!p || p.lat == null) continue;
        if (
          raw &&
          (String(p.name).toLowerCase() === raw ||
            String(p.address).toLowerCase() === raw)
        ) {
          return {
            lat: String(p.lat),
            lon: String(p.lng),
            display_name: p.address,
            type: "city",
            address: {},
          };
        }
      }
      return original(name, countryHint);
    };
    patched.__gpPatched = true;
    window.geocodeAnyGlobalLocation = patched;
  }

  function boot() {
    attachAll();
    patchGeocoder();
    setInterval(function () {
      attachAll();
      patchGeocoder();
    }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
