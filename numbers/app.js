(() => {
  const API = window.CONFIG.API_BASE.replace(/\/$/, "");
  const app = document.getElementById("app");
  const progressEl = document.getElementById("progress");

  // key -> photo lists, fetched from the worker
  let photosByNumber = {};

  const imgUrl = (key) => `${API}/img/${key}`;

  // ---- "my uploads" — lets a contributor undo their own photo, even after
  // a reload, without any account. The server hands back a per-photo
  // deleteToken at upload time; we keep it in this browser's localStorage.
  const MY_UPLOADS_KEY = "numbersGallery.myUploads";

  function loadMyUploads() {
    try {
      return JSON.parse(localStorage.getItem(MY_UPLOADS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function rememberUpload(key, deleteToken) {
    const mine = loadMyUploads();
    mine[key] = deleteToken;
    localStorage.setItem(MY_UPLOADS_KEY, JSON.stringify(mine));
  }

  function forgetUpload(key) {
    const mine = loadMyUploads();
    delete mine[key];
    localStorage.setItem(MY_UPLOADS_KEY, JSON.stringify(mine));
  }

  // ---- form memory — remembers what a contributor typed last time (name,
  // location, comments, etc.) so they don't retype it on every submission.
  // The number(s) a photo is tagged with are deliberately never remembered.
  const FORM_MEMORY_KEY = "numbersGallery.formMemory";
  const FORM_MEMORY_FIELDS = [
    ["submitter", ".f-submitter"],
    ["theirNumber", ".f-their-number"],
    ["favoriteNumber", ".f-favorite-number"],
    ["contact", ".f-contact"],
    ["location", ".f-location"],
    ["foundAt", ".f-found-at"],
    ["comments", ".f-comments"],
  ];

  function loadFormMemory() {
    try {
      return JSON.parse(localStorage.getItem(FORM_MEMORY_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveFormMemory(meta) {
    const mem = {};
    for (const [key] of FORM_MEMORY_FIELDS) {
      if (meta[key]) mem[key] = meta[key];
    }
    localStorage.setItem(FORM_MEMORY_KEY, JSON.stringify(mem));
  }

  function applyFormMemory(container) {
    const mem = loadFormMemory();
    for (const [key, selector] of FORM_MEMORY_FIELDS) {
      if (!mem[key]) continue;
      const el = container.querySelector(selector);
      if (el) el.value = mem[key];
    }
  }

  // ---- editing your own pictures after the fact ----
  // A contributor holds a deleteToken for every picture they added from this
  // browser, and the API accepts that token for edits too — so they can fill
  // in a contact later without an account. It only reaches pictures added
  // from this browser, which is the honest limit of having no accounts.
  async function patchPhoto(key, token, patch) {
    const res = await fetch(`${API}/api/photo/${key}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `server responded ${res.status}`);
    }
    return res.json();
  }

  async function editOwnContact(p, linkEl) {
    const mine = loadMyUploads();
    const token = mine[p.key];
    if (!token) return;

    const entered = prompt(
      "Contact to show with your pictures — a site, social link, or email:",
      p.contact || ""
    );
    if (entered === null) return; // cancelled

    // every picture of theirs that's still in the gallery
    const owned = allEntries().filter((e) => mine[e.key]);
    let targets = [p];
    if (owned.length > 1) {
      targets = confirm(
        `Apply this to all ${owned.length} of your pictures? ` +
        "Cancel to change only this one."
      ) ? owned : [p];
    }

    const original = linkEl.textContent;
    linkEl.textContent = "[saving…]";
    try {
      for (const target of targets) {
        await patchPhoto(target.key, mine[target.key], { contact: entered });
      }
      await loadPhotos();
      render();
    } catch (err) {
      linkEl.textContent = original;
      alert(`Couldn't save that: ${err.message}`);
    }
  }

  async function undoUpload(key, linkEl) {
    const mine = loadMyUploads();
    const token = mine[key];
    if (!token) return;
    linkEl.textContent = "[removing…]";
    try {
      const res = await fetch(`${API}/api/photo/${key}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`server responded ${res.status}`);
      forgetUpload(key);
      await loadPhotos();
      render();
    } catch (err) {
      linkEl.textContent = "[remove]";
      alert(`Couldn't remove that picture: ${err.message}`);
    }
  }

  // "7, 42, 7" -> [7, 42] — parses a free-text number list, dedupes, drops junk.
  function parseNumberList(raw) {
    if (!raw) return [];
    const seen = new Set();
    const out = [];
    for (const part of String(raw).split(",")) {
      const n = parseInt(part.trim(), 10);
      if (Number.isInteger(n) && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }

  // ---- lightweight duplicate-upload guard ----
  const RECENT_SIG_KEY = "numbersGallery.recentUploadSignatures";
  const fileSignature = (file) => `${file.name}::${file.size}`;

  function loadRecentSignatures() {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(RECENT_SIG_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function saveRecentSignatures(set) {
    sessionStorage.setItem(RECENT_SIG_KEY, JSON.stringify([...set].slice(-50)));
  }

  // "2026-07-16T10:00:00Z" -> "3 days ago"
  function relativeTime(iso) {
    const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    const units = [
      [60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.345, "week"],
      [12, "month"], [Infinity, "year"],
    ];
    let value = sec;
    for (const [size, name] of units) {
      if (value < size || size === Infinity) {
        value = Math.floor(value);
        if (name === "second") return "just now";
        return value === 1 ? `1 ${name} ago` : `${value} ${name}s ago`;
      }
      value /= size;
    }
    return "a while ago";
  }

  // "2026-07-16" -> "Jul 16, 2026"
  function formatFoundAt(dateStr) {
    try {
      const d = new Date(`${dateStr}T00:00:00`);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  // ---- EXIF (GPS + capture date), read straight from the JPEG bytes ----
  // No library — this is a small hand-rolled reader scoped to just the two
  // tags we need. Returns {} when there's nothing readable; `reason` says
  // why, so the form can explain itself instead of just going blank.
  //
  // Phones are the hard case here: the file's reported MIME type is often
  // wrong or empty coming out of a photo picker, and some cameras put a big
  // thumbnail or maker-note blob ahead of the GPS data — so we sniff the
  // real bytes rather than trusting file.type, and read a generous window.
  const EXIF_SCAN_BYTES = 2 * 1024 * 1024;

  function sniffImageKind(view) {
    if (view.byteLength >= 3 &&
        view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8 && view.getUint8(2) === 0xff) {
      return "jpeg";
    }
    // ISO-BMFF container ("....ftypXXXX") — HEIC/HEIF, as iPhones store photos
    if (view.byteLength >= 12 && view.getUint32(4) === 0x66747970) {
      const brand = String.fromCharCode(
        view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
      );
      if (/^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(brand)) return "heic";
      return "bmff";
    }
    if (view.byteLength >= 8 && view.getUint32(0) === 0x89504e47) return "png";
    return "other";
  }

  // Walk the JPEG segment chain looking for the APP1 "Exif\0\0" marker.
  function findExifOffset(view) {
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffd9 || marker === 0xffda) break; // image data starts
      const size = view.getUint16(offset + 2);
      if (size < 2) break; // malformed length, don't loop forever
      if (marker === 0xffe1 && offset + 10 <= view.byteLength &&
          view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
        return offset + 10;
      }
      offset += 2 + size;
    }
    // Segment walking failed (a non-standard segment can derail it) — fall
    // back to scanning for the signature directly.
    for (let i = 2; i + 10 <= view.byteLength; i++) {
      if (view.getUint8(i) === 0xff && view.getUint8(i + 1) === 0xe1 &&
          view.getUint32(i + 4) === 0x45786966 && view.getUint16(i + 8) === 0x0000) {
        return i + 10;
      }
    }
    return null;
  }

  async function readExif(file) {
    let view;
    try {
      const buf = await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer();
      view = new DataView(buf);
    } catch {
      return { reason: "unreadable" };
    }
    if (view.byteLength < 12) return { reason: "unreadable" };

    const kind = sniffImageKind(view);
    if (kind === "heic") return { reason: "heic" };
    if (kind !== "jpeg") return { reason: "no-exif" }; // PNG/WebP carry none

    const exifOffset = findExifOffset(view);
    if (exifOffset == null || exifOffset + 8 > view.byteLength) return { reason: "no-exif" };

    try {
      const little = view.getUint16(exifOffset) === 0x4949;
      const get16 = (o) => view.getUint16(o, little);
      const get32 = (o) => view.getUint32(o, little);

      const readIFD = (ifdOffset) => {
        const entries = {};
        const count = get16(ifdOffset);
        for (let i = 0; i < count; i++) {
          const eo = ifdOffset + 2 + i * 12;
          entries[get16(eo)] = { type: get16(eo + 2), num: get32(eo + 4), valueOffset: eo + 8 };
        }
        return entries;
      };
      const rational = (o) => {
        const num = get32(o), den = get32(o + 4);
        return den ? num / den : 0;
      };
      const readString = (entry) => {
        const len = entry.num;
        const at = len <= 4 ? entry.valueOffset : exifOffset + get32(entry.valueOffset);
        let s = "";
        for (let i = 0; i < len - 1; i++) s += String.fromCharCode(view.getUint8(at + i));
        return s.replace(/\0/g, "").trim();
      };
      const readRationalArray = (entry) => {
        const at = exifOffset + get32(entry.valueOffset);
        const out = [];
        for (let i = 0; i < entry.num; i++) out.push(rational(at + i * 8));
        return out;
      };

      const ifd0 = readIFD(exifOffset + get32(exifOffset + 4));
      const result = {};

      if (ifd0[0x0132]) result.takenAt = readString(ifd0[0x0132]);
      if (ifd0[0x8769]) {
        const subIfd = readIFD(exifOffset + get32(ifd0[0x8769].valueOffset));
        if (subIfd[0x9003]) result.takenAt = readString(subIfd[0x9003]);
      }

      if (ifd0[0x8825]) {
        const gpsIfd = readIFD(exifOffset + get32(ifd0[0x8825].valueOffset));
        if (gpsIfd[1] && gpsIfd[2] && gpsIfd[3] && gpsIfd[4]) {
          const latRef = readString(gpsIfd[1]).toUpperCase();
          const [d1 = 0, m1 = 0, s1 = 0] = readRationalArray(gpsIfd[2]);
          const lonRef = readString(gpsIfd[3]).toUpperCase();
          const [d2 = 0, m2 = 0, s2 = 0] = readRationalArray(gpsIfd[4]);
          let lat = d1 + m1 / 60 + s1 / 3600;
          let lon = d2 + m2 / 60 + s2 / 3600;
          if (latRef === "S") lat = -lat;
          if (lonRef === "W") lon = -lon;
          // Some cameras write an all-zero GPS block when they had no fix —
          // that's null island, not a real place.
          const usable =
            Number.isFinite(lat) && Number.isFinite(lon) &&
            Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
            !(lat === 0 && lon === 0);
          if (usable) {
            result.lat = lat;
            result.lon = lon;
          }
        }
      }
      if (result.lat == null) result.reason = "no-gps";
      return result;
    } catch {
      return { reason: "unreadable" }; // malformed EXIF — just skip it
    }
  }

  // "2026:07:16 10:00:00" -> "2026-07-16"
  function exifDateToInputValue(exifDate) {
    if (!exifDate || exifDate.length < 10) return "";
    return exifDate.slice(0, 10).replace(/:/g, "-");
  }

  // Reverse/forward geocoding via OpenStreetMap's Nominatim (free, no key).
  // Labels go town → county/area → state/region → country, so places in
  // countries with meaningful subdivisions (US states, UK counties, …) keep
  // that context. Never street addresses, never postcodes — postcodes can be
  // near-address precision in some countries (UK), which we deliberately
  // don't collect.
  function placeLabel(addr) {
    const parts = [
      addr.city || addr.town || addr.village || addr.municipality || addr.hamlet || "",
      addr.county || addr.state_district || "",
      addr.state || addr.province || addr.region || "",
      addr.country || "",
    ];
    // Dedupe repeats like "Berlin, Berlin, Germany" (city-states etc.).
    const out = [];
    for (const p of parts) {
      if (p && !out.includes(p)) out.push(p);
    }
    return out.join(", ");
  }

  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lon}&zoom=10`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) return "";
      const data = await res.json();
      return placeLabel(data.address || {});
    } catch {
      return "";
    }
  }

  function wireLocationAutocomplete(input, datalist) {
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) return;
      timer = setTimeout(async () => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&q=${encodeURIComponent(q)}&limit=5`,
            { headers: { Accept: "application/json" } }
          );
          if (!res.ok) return;
          const data = await res.json();
          datalist.replaceChildren();
          const seen = new Set();
          for (const place of data) {
            const label = placeLabel(place.address || {});
            if (!label || seen.has(label)) continue;
            seen.add(label);
            const opt = document.createElement("option");
            opt.value = label;
            datalist.appendChild(opt);
          }
        } catch {
          /* ignore — autocomplete is a nicety, not required */
        }
      }, 400);
    });
  }

  // Best-effort number guess from the photo itself, via the worker's vision
  // model — a pre-fill suggestion only, never trusted outright (the model
  // does misread digits sometimes). Returns the guessed number as a string,
  // or null if nothing was found or the request failed.
  async function detectNumberInPhoto(file) {
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await fetch(`${API}/api/detect-number`, { method: "POST", body: form });
      if (!res.ok) return null;
      const body = await res.json();
      return body.number || null;
    } catch {
      return null;
    }
  }

  // Applies EXIF-derived location/date to a form's fields, if their
  // "use metadata" checkboxes are checked. Called once a file is staged.
  // Many phones don't embed GPS/date at all (location tagging off, HEIC
  // stripped on conversion, etc.) — when that happens we uncheck the box
  // and unlock the field instead of leaving it stuck empty and disabled,
  // since that reads as "broken" rather than "no data in this photo".
  // Phones commonly hand over photos with the location already stripped —
  // by the camera's own settings, or by the photo picker on the way out.
  // Naming the likely cause beats a blank field the person can't explain.
  function locationHint(exif) {
    if (exif.reason === "heic") {
      return "couldn't read this photo's data — type the place in";
    }
    if (exif.lat == null && exif.reason === "no-gps") {
      return "this photo has no location saved — type it in";
    }
    if (exif.reason === "no-exif" || exif.reason === "unreadable") {
      return "this photo carries no location — type it in";
    }
    return "couldn't find a location — type it in"; // had GPS, geocoding failed
  }

  async function applyExifMetadata(container, file) {
    const exif = await readExif(file);

    // A box that unchecked itself for an earlier photo ("no data in that
    // one") re-arms for this new photo — otherwise one GPS-less photo would
    // permanently kill metadata detection for the rest of the form. Only a
    // person's own uncheck (a real click) is treated as permanent.
    const rearm = (checkbox) => {
      if (checkbox && !checkbox.checked && checkbox.dataset.autoUnchecked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change"));
      }
    };
    const autoUncheck = (checkbox) => {
      checkbox.checked = false;
      checkbox.dataset.autoUnchecked = "1";
      checkbox.dispatchEvent(new Event("change"));
    };

    const locCheckbox = container.querySelector(".f-location-metadata");
    const locInput = container.querySelector(".f-location");
    rearm(locCheckbox);
    if (locCheckbox && locCheckbox.checked) {
      delete locCheckbox.dataset.autoUnchecked;
      // The checked box promises "this value comes from the photo", so any
      // previous content — including the location remembered from the last
      // submission — must not survive into a new photo's slot.
      locInput.value = "";
      locInput.placeholder = "";
      if (exif.lat != null && exif.lon != null) {
        locInput.value = "looking up…";
        locInput.value = (await reverseGeocode(exif.lat, exif.lon)) || "";
      }
      if (!locInput.value) {
        autoUncheck(locCheckbox);
        locInput.placeholder = locationHint(exif);
      }
    }

    const whenCheckbox = container.querySelector(".f-found-at-metadata");
    const whenInput = container.querySelector(".f-found-at");
    rearm(whenCheckbox);
    if (whenCheckbox && whenCheckbox.checked) {
      delete whenCheckbox.dataset.autoUnchecked;
      whenInput.value = exifDateToInputValue(exif.takenAt);
      if (!whenInput.value) {
        autoUncheck(whenCheckbox);
      }
    }
  }

  async function loadPhotos() {
    const res = await fetch(`${API}/api/photos`);
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    photosByNumber = await res.json();
  }

  // Numbers 1-100 get their own grid cell; anything else (0, negatives,
  // 101+) is grouped under the "misc" bucket.
  function currentNumber() {
    const m = location.hash.match(/^#\/?(-?\d{1,6})$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 100 ? n : null;
  }

  function findFirstEmpty() {
    for (let i = 1; i <= 100; i++) {
      if (!(photosByNumber[i] && photosByNumber[i].length)) return i;
    }
    return null;
  }

  function miscEntries() {
    const seen = new Set();
    const entries = [];
    for (const [k, list] of Object.entries(photosByNumber)) {
      const n = parseInt(k, 10);
      if (n >= 1 && n <= 100) continue;
      for (const p of list) {
        if (seen.has(p.key)) continue; // dedupe if tagged with >1 out-of-range number
        seen.add(p.key);
        entries.push(p);
      }
    }
    entries.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));
    return entries;
  }

  function allEntries() {
    const seen = new Set();
    const entries = [];
    for (const list of Object.values(photosByNumber)) {
      for (const p of list) {
        if (seen.has(p.key)) continue; // dedupe multi-tagged photos
        seen.add(p.key);
        entries.push(p);
      }
    }
    return entries;
  }

  function setView(view) {
    document.body.classList.remove("view-grid", "view-detail", "view-misc", "view-terms", "view-all");
    document.body.classList.add(`view-${view}`);
  }

  function setWordmark(text) {
    const wm = document.getElementById("home-link");
    if (wm) wm.textContent = text;
  }

  function render() {
    if (location.hash === "#/terms") {
      setView("terms");
      renderTerms();
    } else if (location.hash === "#/all") {
      setView("all");
      renderAll();
    } else if (location.hash === "#/people") {
      setView("all");
      renderPeople();
    } else if (location.hash === "#/misc") {
      setView("misc");
      renderMisc();
    } else {
      const n = currentNumber();
      if (n) {
        setView("detail");
        renderDetail(n);
      } else {
        setView("grid");
        renderGrid();
      }
    }
    window.scrollTo(0, 0);
  }

  function renderTerms() {
    document.title = "give or take — terms";
    setWordmark("The Game Where We Collect Numbers");
    const section = document.createElement("section");
    section.className = "detail-section";

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);

    const heading = document.createElement("h2");
    heading.className = "terms-heading";
    heading.textContent = "Photo terms";
    section.appendChild(heading);

    const addParagraphs = (texts) => {
      texts.forEach((text) => {
        const p = document.createElement("p");
        p.className = "terms-copy";
        p.textContent = text;
        section.appendChild(p);
      });
    };
    const addHeading = (text) => {
      const h = document.createElement("h2");
      h.className = "terms-heading";
      h.textContent = text;
      section.appendChild(h);
    };
    const addList = (items) => {
      const ul = document.createElement("ul");
      ul.className = "terms-copy";
      items.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      });
      section.appendChild(ul);
    };

    addParagraphs([
      "By submitting a photo to Give or Take, you confirm it's yours to share, and you give anyone — us, other visitors, anyone on the internet — permission to use, copy, modify, print, or republish it, for any purpose, without asking first and without paying you. You're not giving up ownership of the photo — you're just saying nobody needs your permission to use it.",
      "Don't submit a photo you don't have the rights to share, or one that includes other identifiable people without their OK.",
      "Photos publish immediately and are not reviewed before appearing on the site.",
    ]);

    addHeading("What's stored on your device");
    addParagraphs([
      "This site sets no cookies and runs no analytics or advertising trackers. It does keep a few things in your browser's own storage, purely so the site works the way you'd expect:",
    ]);
    addList([
      "what you last typed into the form — your name, contact, location and so on — so you don't have to type it again next time",
      "a private token for each picture you add, which is the only thing that lets you remove that picture later",
      "which pictures you'd already seen, to work out the “new since your last visit” count",
      "your sorting and picture-size choices on the all-pictures page",
    ]);
    addParagraphs([
      "None of that is sent anywhere or shared with anyone — it stays in your browser, on this device. Clearing your browsing data wipes it, including the tokens that let you delete your own pictures, so those pictures would stay up.",
    ]);

    addHeading("What leaves your device");
    addList([
      "The photo and everything you type alongside it — name, contact, location, date, comments — are published publicly on this site for anyone to see.",
      "Pictures and their details are stored on Cloudflare, which hosts this project's back end.",
      "If you let a photo fill in its own location, the coordinates from that photo are sent to OpenStreetMap's Nominatim service to turn them into a place name. If you type a location instead, what you type is sent there to fetch suggestions.",
      "Nothing else is shared, and nothing is sold.",
    ]);

    app.replaceChildren(section);
  }

  // ---- "new since your last visit" ----
  // Per-browser only, since there are no accounts.
  //
  // The baseline is the newest photo's own upload timestamp as of your last
  // visit — deliberately NOT the wall-clock time you visited. Comparing the
  // device's clock against server timestamps made the count drift whenever
  // the two disagreed (phone clocks are routinely off by minutes), which is
  // what made this unstable. Server times compared against server times
  // can't drift.
  //
  // It's pinned in sessionStorage for the length of a visit so reloading or
  // moving between pages keeps showing the same count instead of zeroing it
  // before you've had a chance to go and look.
  const LAST_SEEN_KEY = "numbersGallery.lastSeenNewest";
  const VISIT_BASELINE_KEY = "numbersGallery.visitBaseline";
  let visitBaseline; // undefined until resolved once per page load

  function newestUploadedAt(entries) {
    let newest = 0;
    for (const p of entries) {
      const t = new Date(p.uploaded).getTime();
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    return newest;
  }

  function getVisitBaseline() {
    if (visitBaseline !== undefined) return visitBaseline;
    try {
      let pinned = sessionStorage.getItem(VISIT_BASELINE_KEY);
      if (pinned === null) {
        // First page of a new visit: compare against whatever was newest
        // when we were last here ("" on a first-ever visit, which shows no
        // badge — there's no "since" to speak of yet).
        pinned = localStorage.getItem(LAST_SEEN_KEY) || "";
        sessionStorage.setItem(VISIT_BASELINE_KEY, pinned);
      }
      visitBaseline = pinned ? Number(pinned) || 0 : 0;
    } catch {
      visitBaseline = 0; // storage blocked (private mode) — skip the feature
    }
    return visitBaseline;
  }

  function countAddedSince(baseline, entries) {
    if (!baseline) return 0;
    return entries.filter((p) => {
      const t = new Date(p.uploaded).getTime();
      return Number.isFinite(t) && t > baseline;
    }).length;
  }

  // Remember the newest photo we've shown, so the next visit compares
  // against it. Safe to call repeatedly; only ever moves forward.
  function rememberSeen(newest) {
    if (!newest) return;
    try {
      const prev = Number(localStorage.getItem(LAST_SEEN_KEY)) || 0;
      if (newest > prev) localStorage.setItem(LAST_SEEN_KEY, String(newest));
    } catch {
      /* storage blocked — nothing to remember with */
    }
  }

  function renderProgress() {
    const collected = Object.entries(photosByNumber).filter(([k, list]) => {
      const n = parseInt(k, 10);
      return n >= 1 && n <= 100 && list.length > 0;
    }).length;
    const entries = allEntries();
    const total = entries.length;
    const added = countAddedSince(getVisitBaseline(), entries);
    rememberSeen(newestUploadedAt(entries));

    let html = `<strong>${collected}</strong> of 100 collected`;
    html += ` &middot; <strong>${total}</strong> pics`;
    if (added > 0) {
      // added since the last visit — the title spells out what "+3" means
      html += ` <span class="progress-new" title="added since your last visit">(+${added})</span>`;
    }
    progressEl.innerHTML = html;
  }

  function buildCell(label, photos, href) {
    const filled = photos.length > 0;
    const cell = document.createElement("a");
    cell.href = href;
    cell.className = `cell ${filled ? "filled" : "empty"}`;
    cell.setAttribute("aria-label", `${label}, ${photos.length} pictures`);

    if (filled) {
      cell.title = label;

      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = `Picture of ${label}`;
      img.src = imgUrl(photos[photos.length - 1].key);
      cell.appendChild(img);

      const plus = document.createElement("span");
      plus.className = "cell-mark cell-mark-plus";
      plus.textContent = "+";
      cell.appendChild(plus);

      const count = document.createElement("span");
      count.className = "cell-mark cell-mark-count";
      count.textContent = photos.length > 1 ? `${label}×${photos.length}` : `${label}`;
      cell.appendChild(count);
    } else {
      const numberLabel = document.createElement("span");
      numberLabel.className = "cell-empty-label";
      numberLabel.textContent = label;
      cell.appendChild(numberLabel);

      const plus = document.createElement("span");
      plus.className = "cell-mark cell-mark-plus cell-mark-empty";
      plus.textContent = "+";
      cell.appendChild(plus);
    }
    return cell;
  }

  function renderGrid() {
    document.title = "numberwang";
    setWordmark("The Game Where We Collect Numbers");
    const grid = document.createElement("div");
    grid.className = "number-grid";
    for (let i = 1; i <= 100; i++) {
      grid.appendChild(buildCell(String(i), photosByNumber[i] || [], `#/${i}`));
    }
    grid.appendChild(buildCell("misc", miscEntries(), "#/misc"));

    const section = document.createElement("section");
    section.className = "grid-section";
    section.appendChild(grid);

    app.replaceChildren(section);
    renderProgress();
  }

  // Turns a contributor's contact string into a URL. Accepts http:// and
  // https:// as typed, e-mail addresses, and bare domains with or without
  // www and with or without a path ("pterodactyl.supplies", "example.com/me").
  // Bare domains get https:// since that's what a browser's address bar
  // would try first. Anything else — a handle, a phone number, free text —
  // returns null and is simply not linked.
  function contactHref(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;
    if (/^https?:\/\/\S+$/i.test(value)) return value;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
    if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(value)) {
      return `https://${value}`;
    }
    return null;
  }

  // Decides how a contact should appear beside the name:
  //   { href, label } — a real address, shown as a short readable link
  //   { text }        — a handle or similar, shown as plain text
  //   null            — nothing worth showing
  // Anything still wearing a URL scheme we don't trust (javascript:, data:)
  // is dropped outright rather than printed: it's either junk or a trick,
  // and neither belongs under someone's photo.
  function contactDisplay(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;

    const href = contactHref(value);
    if (href) {
      let label = value;
      if (href.startsWith("mailto:")) {
        label = href.slice(7);
      } else {
        try {
          label = new URL(href).host.replace(/^www\./i, "");
        } catch {
          /* keep the raw value as the label */
        }
      }
      return { href, label };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    return { text: value };
  }

  // The link shown next to the contributor's name. The visible label is the
  // domain (or e-mail address), so people can see where they're going before
  // they click; the full URL rides along in the title. Outbound links get
  // noopener/noreferrer, plus nofollow/ugc so the gallery can't be farmed
  // for SEO.
  function contactNode(display) {
    if (display.text) return document.createTextNode(display.text);
    const a = document.createElement("a");
    a.href = display.href;
    a.textContent = display.label;
    a.title = display.href;
    if (!display.href.startsWith("mailto:")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow ugc";
    }
    return a;
  }

  function buildGalleryItem(p, i, total, currentN, mine, opts = {}) {
    const item = document.createElement("div");
    item.className = "gallery-item";

    const link = document.createElement("a");
    link.href = imgUrl(p.key);
    link.target = "_blank";
    link.rel = "noopener";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = currentN != null ? `Picture of the number ${currentN}` : `Picture marked ${p.numbers.join(", ")}`;
    img.src = imgUrl(p.key);
    link.appendChild(img);
    item.appendChild(link);

    const caption = document.createElement("div");
    caption.className = "gallery-caption";
    if (opts.caption) {
      caption.appendChild(opts.caption);
    } else {
      caption.textContent = `number ${i + 1} of ${total}`;
    }
    item.appendChild(caption);

    const meta = document.createElement("div");
    meta.className = "gallery-meta";
    const name = p.submitter || "anonymous";
    const nameText = p.theirNumber ? `${name} (${p.theirNumber})` : name;
    meta.appendChild(document.createTextNode(nameText));

    // Contact sits immediately after the name, as its own item.
    const contact = contactDisplay(p.contact);
    if (contact) {
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(contactNode(contact));
    }

    const bits = [];
    if (opts.caption) {
      // the caption already names the photo's numbers — no "marked" bit
    } else if (currentN != null) {
      const alsoOn = (p.numbers || []).filter((x) => x !== currentN);
      if (alsoOn.length) bits.push(`also on ${alsoOn.join(", ")}`);
    } else {
      bits.push(`marked ${p.numbers.join(", ")}`);
    }
    if (p.location) bits.push(p.location);
    if (p.foundAt) bits.push(`found ${formatFoundAt(p.foundAt)}`);
    bits.push(`published ${relativeTime(p.uploaded)}`);
    meta.appendChild(document.createTextNode(` · ${bits.join(" · ")}`));
    item.appendChild(meta);

    if (p.comments) {
      const comment = document.createElement("div");
      comment.className = "gallery-comment";
      comment.textContent = `“${p.comments}”`;
      item.appendChild(comment);
    }

    if (mine[p.key]) {
      const ownerRow = document.createElement("div");
      ownerRow.className = "owner-row";

      const editContact = document.createElement("a");
      editContact.href = "#";
      editContact.className = "owner-link";
      editContact.textContent = p.contact ? "[edit contact]" : "[add contact]";
      editContact.addEventListener("click", (e) => {
        e.preventDefault();
        editOwnContact(p, editContact);
      });
      ownerRow.appendChild(editContact);

      const undo = document.createElement("a");
      undo.href = "#";
      undo.className = "undo-link";
      undo.textContent = "[remove]";
      undo.addEventListener("click", (e) => {
        e.preventDefault();
        if (confirm("Remove this picture? This can't be undone.")) {
          undoUpload(p.key, undo);
        }
      });
      ownerRow.appendChild(undo);

      item.appendChild(ownerRow);
    }

    return item;
  }

  function renderDetail(n) {
    document.title = `numberwang (${n})`;
    setWordmark(`Give or Take ${n}`);
    const photos = photosByNumber[n] || [];
    const mine = loadMyUploads();
    const section = document.createElement("section");
    section.className = "detail-section";

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);

    const prevN = n <= 1 ? 100 : n - 1;
    const nextN = n >= 100 ? 1 : n + 1;

    const navRow = document.createElement("div");
    navRow.className = "detail-nav-row";
    navRow.innerHTML = `
      <a href="#/${prevN}">&larr; ${prevN}</a>
      <div class="detail-center">
        <div class="detail-number">${n}</div>
        <div class="detail-meta">${photos.length} picture${photos.length === 1 ? "" : "s"} on file</div>
      </div>
      <a href="#/${nextN}">${nextN} &rarr;</a>`;
    section.appendChild(navRow);

    if (photos.length) {
      const gallery = document.createElement("div");
      gallery.id = "detail-gallery";
      photos.forEach((p, i) => gallery.appendChild(buildGalleryItem(p, i, photos.length, n, mine)));
      section.appendChild(gallery);
    } else {
      const empty = document.createElement("div");
      empty.className = "no-photos";
      empty.textContent = `Nobody uploaded a ${n} yet - be the first!`;
      section.appendChild(empty);
    }

    section.appendChild(buildUploadPanel(n));
    app.replaceChildren(section);
    renderProgress();
  }

  function renderMisc() {
    document.title = "numberwang";
    setWordmark("The Game Where We Collect Numbers");
    const entries = miscEntries();
    const mine = loadMyUploads();
    const section = document.createElement("section");
    section.className = "detail-section";

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);

    const navRow = document.createElement("div");
    navRow.className = "detail-nav-row";
    navRow.innerHTML = `
      <span></span>
      <div class="detail-center">
        <div class="detail-eyebrow">misc</div>
        <div class="detail-number">&infin;</div>
        <div class="detail-meta">${entries.length} picture${entries.length === 1 ? "" : "s"} on file</div>
      </div>
      <span></span>`;
    section.appendChild(navRow);

    if (entries.length) {
      const gallery = document.createElement("div");
      gallery.id = "misc-gallery";
      entries.forEach((p, i) => gallery.appendChild(buildGalleryItem(p, i, entries.length, null, mine)));
      section.appendChild(gallery);
    } else {
      const empty = document.createElement("div");
      empty.className = "no-photos";
      empty.textContent = "Nothing here yet — numbers that don't fit 1–100 land here.";
      section.appendChild(empty);
    }

    const hint = document.createElement("p");
    hint.className = "gallery-meta";
    hint.style.textAlign = "center";
    hint.style.marginTop = "24px";
    hint.textContent = "Use “add a number” above to add something here.";
    section.appendChild(hint);

    app.replaceChildren(section);
    renderProgress();
  }

  // ---- "people" page (unlisted, #/people) ----
  // Groups every picture by contributor. A method number identifies a person
  // better than a name does — names repeat and get typed differently — so
  // it's the grouping key whenever it's present, with the name as fallback.
  function groupPeople() {
    const people = new Map();
    for (const p of allEntries()) {
      const name = (p.submitter || "anonymous").trim();
      const method = (p.theirNumber || "").trim();
      const key = method ? `#${method.toLowerCase()}` : `name:${name.toLowerCase()}`;

      let person = people.get(key);
      if (!person) {
        person = {
          names: new Set(),
          method,
          contacts: new Set(),
          photos: [],
          numbers: new Set(),
          locations: new Set(),
        };
        people.set(key, person);
      }
      person.names.add(name);
      if (p.contact) person.contacts.add(p.contact);
      if (p.location) person.locations.add(p.location);
      p.numbers.forEach((n) => person.numbers.add(n));
      person.photos.push(p);
    }

    return [...people.values()]
      .map((person) => {
        const times = person.photos
          .map((p) => new Date(p.uploaded).getTime())
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        return {
          ...person,
          count: person.photos.length,
          first: times[0] || null,
          last: times[times.length - 1] || null,
        };
      })
      .sort((a, b) => b.count - a.count || [...a.names][0].localeCompare([...b.names][0]));
  }

  function renderPeople() {
    document.title = "numberwang — people";
    setWordmark("The Game Where We Collect Numbers");

    const section = document.createElement("section");
    section.className = "detail-section";

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);

    const people = groupPeople();
    const totalPhotos = people.reduce((sum, person) => sum + person.count, 0);

    const heading = document.createElement("h2");
    heading.className = "terms-heading";
    heading.textContent = `${people.length} ${people.length === 1 ? "person" : "people"}, ${totalPhotos} pictures`;
    section.appendChild(heading);

    if (!people.length) {
      const empty = document.createElement("div");
      empty.className = "no-photos";
      empty.textContent = "Nobody has added anything yet.";
      section.appendChild(empty);
      app.replaceChildren(section);
      renderProgress();
      return;
    }

    const table = document.createElement("table");
    table.className = "people-table";

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["person", "method no.", "contact", "pictures", "numbers", "first", "latest"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const tbody = document.createElement("tbody");
    for (const person of people) {
      const tr = document.createElement("tr");

      const nameCell = document.createElement("td");
      // a person can appear under more than one spelling of their name
      nameCell.textContent = [...person.names].join(" / ");
      tr.appendChild(nameCell);

      const methodCell = document.createElement("td");
      methodCell.className = "num";
      methodCell.textContent = person.method || "—";
      tr.appendChild(methodCell);

      const contactCell = document.createElement("td");
      const contacts = [...person.contacts];
      if (!contacts.length) {
        contactCell.textContent = "—";
      } else {
        contacts.forEach((raw, i) => {
          const display = contactDisplay(raw);
          if (!display) return;
          if (i) contactCell.appendChild(document.createTextNode(", "));
          contactCell.appendChild(contactNode(display));
        });
        if (!contactCell.childNodes.length) contactCell.textContent = "—";
      }
      tr.appendChild(contactCell);

      const countCell = document.createElement("td");
      countCell.className = "num";
      countCell.textContent = person.count;
      tr.appendChild(countCell);

      const numbersCell = document.createElement("td");
      numbersCell.className = "num";
      [...person.numbers]
        .sort((a, b) => a - b)
        .forEach((n, i) => {
          if (i) numbersCell.appendChild(document.createTextNode(", "));
          const a = document.createElement("a");
          a.href = n >= 1 && n <= 100 ? `#/${n}` : "#/misc";
          a.textContent = n;
          numbersCell.appendChild(a);
        });
      tr.appendChild(numbersCell);

      const firstCell = document.createElement("td");
      firstCell.textContent = person.first ? new Date(person.first).toLocaleDateString() : "—";
      tr.appendChild(firstCell);

      const lastCell = document.createElement("td");
      lastCell.textContent = person.last ? new Date(person.last).toLocaleDateString() : "—";
      tr.appendChild(lastCell);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const scroller = document.createElement("div");
    scroller.className = "table-scroll";
    scroller.appendChild(table);
    section.appendChild(scroller);

    app.replaceChildren(section);
    renderProgress();
  }

  // ---- "all pictures" page: every photo in one masonry wall, sortable ----
  const ALL_PREFS_KEY = "numbersGallery.allPrefs";

  function loadAllPrefs() {
    try {
      return JSON.parse(localStorage.getItem(ALL_PREFS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function renderAll() {
    document.title = "numberwang — all pictures";
    setWordmark("The Game Where We Collect Numbers");
    const mine = loadMyUploads();
    const prefs = Object.assign({ sort: "added", dir: "desc", width: 220 }, loadAllPrefs());
    const savePrefs = () => localStorage.setItem(ALL_PREFS_KEY, JSON.stringify(prefs));

    const section = document.createElement("section");
    section.className = "detail-section";

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);

    const entries = allEntries();

    const controls = document.createElement("div");
    controls.className = "all-controls";

    const countEl = document.createElement("span");
    countEl.textContent = `${entries.length} picture${entries.length === 1 ? "" : "s"}`;
    controls.appendChild(countEl);

    const sortLabel = document.createElement("label");
    sortLabel.appendChild(document.createTextNode("sort by"));
    const sortSel = document.createElement("select");
    for (const [value, text] of [["added", "date added"], ["found", "date found"], ["number", "number"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      sortSel.appendChild(opt);
    }
    sortSel.value = prefs.sort;
    sortLabel.appendChild(sortSel);
    controls.appendChild(sortLabel);

    const dirSel = document.createElement("select");
    const dirLabel = document.createElement("label");
    dirLabel.appendChild(dirSel);
    controls.appendChild(dirLabel);
    // direction wording follows the field: dates read better as old/new,
    // numbers as small/large
    function refreshDirOptions() {
      const byDate = sortSel.value !== "number";
      dirSel.replaceChildren();
      for (const [value, text] of [
        ["asc", byDate ? "oldest first" : "smallest first"],
        ["desc", byDate ? "newest first" : "largest first"],
      ]) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        dirSel.appendChild(opt);
      }
      dirSel.value = prefs.dir;
    }
    refreshDirOptions();

    const sizeLabel = document.createElement("label");
    sizeLabel.appendChild(document.createTextNode("picture size"));
    const sizeRange = document.createElement("input");
    sizeRange.type = "range";
    sizeRange.min = "120";
    sizeRange.max = "480";
    sizeRange.step = "20";
    sizeRange.value = String(prefs.width);
    sizeLabel.appendChild(sizeRange);
    controls.appendChild(sizeLabel);

    section.appendChild(controls);

    const gallery = document.createElement("div");
    gallery.id = "all-gallery";
    section.appendChild(gallery);

    // Missing "date found" always sorts last, in either direction — an
    // unknown date isn't older or newer than a known one, just unknown.
    const sortKeys = {
      added: (p) => new Date(p.uploaded).getTime(),
      found: (p) => (p.foundAt ? new Date(p.foundAt).getTime() : null),
      number: (p) => Math.min(...p.numbers),
    };

    function numbersCaption(p) {
      const span = document.createElement("span");
      p.numbers.forEach((n, idx) => {
        if (idx) span.appendChild(document.createTextNode(", "));
        const a = document.createElement("a");
        a.href = n >= 1 && n <= 100 ? `#/${n}` : "#/misc";
        a.textContent = n;
        span.appendChild(a);
      });
      return span;
    }

    let items = [];
    let currentCols = 0;

    function colCount() {
      return Math.max(1, Math.floor((gallery.clientWidth || 0) / prefs.width) || 1);
    }

    // Deal items into N column stacks round-robin (item i → column i % N),
    // so the wall reads left-to-right, row by row.
    function layout() {
      currentCols = colCount();
      const cols = [];
      for (let c = 0; c < currentCols; c++) {
        const col = document.createElement("div");
        col.className = "all-col";
        cols.push(col);
      }
      items.forEach((el, i) => cols[i % currentCols].appendChild(el));
      gallery.replaceChildren(...cols);
    }

    function rebuild() {
      const keyFn = sortKeys[prefs.sort];
      const sorted = [...entries].sort((a, b) => {
        const ka = keyFn(a);
        const kb = keyFn(b);
        if (ka == null && kb == null) return 0;
        if (ka == null) return 1;
        if (kb == null) return -1;
        return prefs.dir === "asc" ? ka - kb : kb - ka;
      });
      items = sorted.map((p, i) =>
        buildGalleryItem(p, i, sorted.length, null, mine, { caption: numbersCaption(p) })
      );
      layout();
    }

    sortSel.addEventListener("change", () => {
      prefs.sort = sortSel.value;
      refreshDirOptions();
      savePrefs();
      rebuild();
    });
    dirSel.addEventListener("change", () => {
      prefs.dir = dirSel.value;
      savePrefs();
      rebuild();
    });
    sizeRange.addEventListener("input", () => {
      prefs.width = Number(sizeRange.value);
      savePrefs();
      if (colCount() !== currentCols) layout();
    });

    const onResize = () => {
      if (!document.contains(gallery)) {
        window.removeEventListener("resize", onResize);
        return;
      }
      if (colCount() !== currentCols) layout();
    };
    window.addEventListener("resize", onResize);

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "no-photos";
      empty.textContent = "No pictures yet.";
      section.appendChild(empty);
    }

    // layout() measures the gallery's width, so it can only run once the
    // section is actually in the document.
    app.replaceChildren(section);
    if (entries.length) rebuild();
    renderProgress();
  }

  // ---- shared form fields (used by both the inline upload panel and the modal) ----
  function buildTextField(labelText, inputClass, mandatory) {
    const wrap = document.createElement("label");
    wrap.className = "field-label";
    const span = document.createElement("span");
    span.textContent = mandatory ? `${labelText} *` : labelText;
    wrap.appendChild(span);
    const input = document.createElement("input");
    input.type = "text";
    input.className = inputClass;
    input.maxLength = 80;
    if (mandatory) input.required = true;
    wrap.appendChild(input);
    return wrap;
  }

  function buildTextareaField(labelText, inputClass) {
    const wrap = document.createElement("label");
    wrap.className = "field-label";
    const span = document.createElement("span");
    span.textContent = labelText;
    wrap.appendChild(span);
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.className = inputClass;
    textarea.maxLength = 500;
    wrap.appendChild(textarea);
    return wrap;
  }

  function buildCheckboxRow(labelText, inputClass) {
    const wrap = document.createElement("label");
    wrap.className = "checkbox-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = inputClass;
    checkbox.checked = true;
    // A click is the person deciding — that choice is permanent, unlike an
    // auto-uncheck (photo had no data), which re-arms on the next photo.
    checkbox.addEventListener("click", () => {
      delete checkbox.dataset.autoUnchecked;
    });
    wrap.appendChild(checkbox);
    wrap.appendChild(document.createTextNode(` ${labelText}`));
    return { wrap, checkbox };
  }

  function buildLocationField() {
    const block = document.createElement("div");
    block.className = "meta-field-block";

    const listId = `location-list-${Math.random().toString(36).slice(2)}`;
    const field = buildTextField("where did you find that", "f-location");
    const input = field.querySelector("input");
    input.setAttribute("list", listId);
    input.maxLength = 250; // room for a manually-typed longer place name
    block.appendChild(field);

    const datalist = document.createElement("datalist");
    datalist.id = listId;
    block.appendChild(datalist);

    const { wrap, checkbox } = buildCheckboxRow("use photo's location", "f-location-metadata");
    block.appendChild(wrap);

    input.disabled = true;
    checkbox.addEventListener("change", () => {
      input.disabled = checkbox.checked;
    });
    // Focus only on a real click-uncheck — an automatic uncheck (photo had
    // no GPS) must not steal focus / pop the keyboard on mobile.
    checkbox.addEventListener("click", () => {
      if (!checkbox.checked) input.focus();
    });
    wireLocationAutocomplete(input, datalist);

    return block;
  }

  function buildWhenField() {
    const block = document.createElement("div");
    block.className = "meta-field-block";

    const label = document.createElement("label");
    label.className = "field-label";
    const span = document.createElement("span");
    span.textContent = "when did you find that";
    label.appendChild(span);
    const input = document.createElement("input");
    input.type = "date";
    input.className = "f-found-at";
    label.appendChild(input);
    block.appendChild(label);

    const { wrap, checkbox } = buildCheckboxRow("use photo's date", "f-found-at-metadata");
    block.appendChild(wrap);

    input.disabled = true;
    checkbox.addEventListener("change", () => {
      input.disabled = checkbox.checked;
    });

    return block;
  }

  function buildAlsoShowsField() {
    const block = document.createElement("div");
    block.className = "meta-field-block";
    block.appendChild(buildTextField("also shows numbers", "f-also-numbers"));
    const hint = document.createElement("p");
    hint.className = "upload-helper";
    hint.textContent = "shows more than one number? separate with commas";
    block.appendChild(hint);
    return block;
  }

  function appendSharedFields(container) {
    const contactField = buildTextField("contact", "f-contact");
    contactField.querySelector("input").maxLength = 200;
    container.appendChild(
      buildPairRow(buildTextField("your name", "f-submitter", true), contactField)
    );

    const contactHint = document.createElement("p");
    contactHint.className = "number-hint";
    contactHint.textContent = "contact is shown publicly, linked where possible";
    container.appendChild(contactHint);

    container.appendChild(
      buildPairRow(
        buildTextField("your method number", "f-their-number"),
        buildTextField("favorite number", "f-favorite-number")
      )
    );
    container.appendChild(buildLocationField());
    container.appendChild(buildWhenField());
    container.appendChild(buildTextareaField("comments", "f-comments"));
  }

  function buildPairRow(left, right) {
    const row = document.createElement("div");
    row.className = "field-pair-row";
    row.appendChild(left);
    row.appendChild(right);
    return row;
  }

  function readSharedFields(container) {
    return {
      location: container.querySelector(".f-location").value,
      foundAt: container.querySelector(".f-found-at").value,
      submitter: container.querySelector(".f-submitter").value,
      theirNumber: container.querySelector(".f-their-number").value,
      favoriteNumber: container.querySelector(".f-favorite-number").value,
      contact: container.querySelector(".f-contact").value,
      comments: container.querySelector(".f-comments").value,
      consent: container.querySelector(".f-consent").checked,
    };
  }

  // Required consent checkbox — placed right above each form's submit button.
  function buildConsentField() {
    const wrap = document.createElement("label");
    wrap.className = "checkbox-label consent-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "f-consent";
    checkbox.required = true;
    checkbox.checked = true;
    wrap.appendChild(checkbox);

    const text = document.createElement("span");
    text.appendChild(document.createTextNode("I agree this photo can be used by anyone, in any way — see "));
    const link = document.createElement("a");
    link.href = "#/terms";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "terms";
    text.appendChild(link);
    text.appendChild(document.createTextNode("."));
    wrap.appendChild(text);

    return wrap;
  }

  // Dropzone: drag & drop, paste, or click-to-browse.
  function buildDropzone({ multiple, mandatory, onFiles }) {
    const zone = document.createElement("label");
    zone.className = "dropzone";
    zone.tabIndex = 0;
    zone.innerHTML = `drag &amp; drop, paste, or <span class="pick-text">choose ${multiple ? "files" : "a photo"}</span>${mandatory ? " *" : ""}`;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    if (multiple) input.multiple = true;
    zone.appendChild(input);

    input.addEventListener("change", () => {
      if (input.files.length) onFiles(input.files);
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    });
    zone.addEventListener("paste", (e) => {
      const items = (e.clipboardData || window.clipboardData).items;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        e.preventDefault();
        onFiles(files);
      }
    });

    return { zone, input };
  }

  function buildUploadPanel(n) {
    const panel = document.createElement("div");
    panel.className = "upload-panel";

    const kicker = document.createElement("p");
    kicker.className = "kicker";
    kicker.textContent = "Submit a number";
    panel.appendChild(kicker);

    const heading = document.createElement("h3");
    heading.textContent = `Add a ${n}`;
    panel.appendChild(heading);

    let stagedFiles = [];

    const fileStatus = document.createElement("p");
    fileStatus.className = "upload-helper";

    const { zone, input: fileInput } = buildDropzone({
      multiple: true,
      mandatory: true,
      onFiles: async (files) => {
        stagedFiles = [...files];
        fileStatus.textContent = `${stagedFiles.length} picture${stagedFiles.length === 1 ? "" : "s"} selected`;
        syncSubmitEnabled();
        await applyExifMetadata(panel, stagedFiles[0]);
      },
    });
    panel.appendChild(zone);

    const helper = document.createElement("p");
    helper.className = "upload-helper";
    helper.textContent = "JPEG, PNG or WebP · published immediately";
    panel.appendChild(helper);
    panel.appendChild(fileStatus);

    panel.appendChild(buildAlsoShowsField());
    appendSharedFields(panel);
    applyFormMemory(panel);

    const consentField = buildConsentField();
    panel.appendChild(consentField);
    const consentCheckbox = consentField.querySelector(".f-consent");

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "modal-submit";
    submitBtn.textContent = "submit";
    submitBtn.disabled = true;
    panel.appendChild(submitBtn);

    const status = document.createElement("div");
    status.className = "upload-status";
    status.setAttribute("role", "status");
    panel.appendChild(status);

    const nameInput = panel.querySelector(".f-submitter");

    function syncSubmitEnabled() {
      submitBtn.disabled = !(stagedFiles.length && nameInput.value.trim() && consentCheckbox.checked);
    }
    nameInput.addEventListener("input", syncSubmitEnabled);
    consentCheckbox.addEventListener("change", syncSubmitEnabled);

    submitBtn.addEventListener("click", () => {
      if (!stagedFiles.length || !nameInput.value.trim() || !consentCheckbox.checked) return;
      const also = parseNumberList(panel.querySelector(".f-also-numbers").value);
      const numbers = parseNumberList([n, ...also].join(","));
      const dt = new DataTransfer();
      stagedFiles.forEach((f) => dt.items.add(f));
      submitPhotos(dt.files, numbers, readSharedFields(panel), status).then((ok) => {
        if (ok) {
          stagedFiles = [];
          fileInput.value = "";
          fileStatus.textContent = "";
          submitBtn.disabled = true;
        }
      });
    });

    return panel;
  }

  // Core upload routine, shared by the upload panel and the modal.
  // `numbers` is the list of numbers this batch of pictures should be
  // tagged with (at least one). Returns true if at least one upload
  // succeeded. On success, reloads data and re-renders.
  async function submitPhotos(fileList, numbers, meta, status) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      setStatus(status, "err", "That doesn't look like an image.");
      return false;
    }
    if (!numbers || !numbers.length) {
      setStatus(status, "err", "Enter at least one number first.");
      return false;
    }
    if (!meta.submitter) {
      setStatus(status, "err", "Your name is required.");
      return false;
    }
    if (!meta.consent) {
      setStatus(status, "err", "You need to agree to the terms before submitting.");
      return false;
    }

    saveFormMemory(meta);

    const recentSigs = loadRecentSignatures();
    let done = 0;
    for (const file of files) {
      const sig = fileSignature(file);
      if (recentSigs.has(sig)) {
        const proceed = confirm(
          `"${file.name}" looks like a picture you already added this session. Upload it again anyway?`
        );
        if (!proceed) continue;
      }

      setStatus(status, "", `Uploading ${done + 1} of ${files.length}…`);
      try {
        const blob = await shrinkImage(file);
        const form = new FormData();
        form.append("numbers", numbers.join(","));
        form.append("photo", blob, "photo.jpg");
        form.append("submitter", meta.submitter);
        form.append("consent", "true");
        if (meta.location) form.append("location", meta.location);
        if (meta.foundAt) form.append("foundAt", meta.foundAt);
        if (meta.theirNumber) form.append("theirNumber", meta.theirNumber);
        if (meta.favoriteNumber) form.append("favoriteNumber", meta.favoriteNumber);
        if (meta.contact) form.append("contact", meta.contact);
        if (meta.comments) form.append("comments", meta.comments);
        const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `upload failed (${res.status})`);
        rememberUpload(body.key, body.deleteToken);
        recentSigs.add(sig);
        saveRecentSignatures(recentSigs);
        done++;
      } catch (err) {
        setStatus(status, "err", `Upload failed: ${err.message}`);
        return done > 0;
      }
    }

    if (!done) {
      setStatus(status, "", "Nothing uploaded.");
      return false;
    }

    await loadPhotos();
    const currentN = currentNumber();
    const onMisc = location.hash === "#/misc";
    const alreadyThere =
      (currentN !== null && numbers.includes(currentN)) ||
      (onMisc && numbers.some((x) => !(x >= 1 && x <= 100)));

    if (alreadyThere) {
      render();
      const freshStatus = app.querySelector(".upload-status");
      if (freshStatus) {
        const onLabel = numbers.length === 1 ? `on ${numbers[0]}` : `on ${numbers.join(", ")}`;
        setStatus(freshStatus, "ok", (done === 1 ? "Picture added " : `${done} pictures added `) + onLabel + "! You can remove it anytime from below.");
      }
    } else {
      const inRangeNumbers = numbers.filter((x) => x >= 1 && x <= 100);
      location.hash = inRangeNumbers.length ? `#/${inRangeNumbers[0]}` : "#/misc";
    }
    return true;
  }

  // Downscale to max 1600px on the long edge and re-encode as JPEG,
  // so phone photos don't eat storage. Falls back to the original file
  // if the browser can't decode it on a canvas.
  async function shrinkImage(file) {
    const MAX = 1600;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85)
      );
      if (blob && blob.size > 0) return blob;
    } catch {
      /* fall through to original */
    }
    return file;
  }

  function setStatus(el, kind, text) {
    el.className = `upload-status ${kind}`;
    el.textContent = text;
  }

  // ---- global "add a number" modal ----
  let modalEls = null;

  function buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.hidden = true;

    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "modal-title");

    const header = document.createElement("div");
    header.className = "modal-header";
    const title = document.createElement("span");
    title.className = "modal-title";
    title.id = "modal-title";
    title.textContent = "Add a number";
    header.appendChild(title);
    const closeLink = document.createElement("a");
    closeLink.href = "#";
    closeLink.className = "modal-close";
    closeLink.textContent = "[x]";
    header.appendChild(closeLink);
    dialog.appendChild(header);

    const numberField = document.createElement("label");
    numberField.className = "field-label";
    const numberLabel = document.createElement("span");
    numberLabel.textContent = "number *";
    numberField.appendChild(numberLabel);
    const numberInput = document.createElement("input");
    numberInput.type = "text";
    numberInput.id = "modal-number";
    numberField.appendChild(numberInput);
    dialog.appendChild(numberField);

    const numberHint = document.createElement("p");
    numberHint.className = "number-hint";
    numberHint.textContent = "shows more than one number? separate with commas";
    dialog.appendChild(numberHint);

    const numberGuessHint = document.createElement("p");
    numberGuessHint.className = "number-hint";
    dialog.appendChild(numberGuessHint);

    // Only overwrite the number field with a photo guess if the contributor
    // hasn't already typed their own value — a guess should never clobber
    // something the person deliberately entered.
    let numberTouched = false;
    numberInput.addEventListener("input", () => { numberTouched = true; });

    let stagedFile = null;
    const { zone, input: fileInput } = buildDropzone({
      multiple: false,
      mandatory: true,
      onFiles: async (files) => {
        stagedFile = files[0];
        numberGuessHint.textContent = "";
        syncSubmitEnabled();
        await applyExifMetadata(dialog, stagedFile);
        await suggestNumber(stagedFile);
      },
    });
    dialog.appendChild(zone);

    async function suggestNumber(file) {
      const wasTouched = numberTouched;
      if (!wasTouched) {
        // Make the wait visible in the field itself — an empty input with a
        // "reading…" placeholder — so the pause reads as work in progress,
        // not as a frozen form. Typing is still allowed and always wins.
        numberInput.value = "";
        numberInput.dispatchEvent(new Event("input"));
        numberTouched = false; // that clear was ours, not the contributor's
        numberInput.placeholder = "reading the photo…";
        numberGuessHint.textContent = "trying to read the number from the photo — or just type it";
      }
      const guess = await detectNumberInPhoto(file);
      if (stagedFile !== file) return; // a different file was staged meanwhile
      numberInput.placeholder = "";
      if (!numberTouched) {
        // Whatever was there before (including the next-empty-slot default
        // openModal fills in) is just as likely to be wrong as no answer at
        // all, so a failed guess leaves the field empty instead of showing
        // a number that looks like an answer but isn't one.
        numberInput.value = guess || "";
        numberInput.dispatchEvent(new Event("input"));
        numberTouched = false; // programmatic fill/clear — still overridable by a later guess
        numberGuessHint.textContent = guess
          ? `guessed "${guess}" from the photo — double check it`
          : "couldn't read a number from this photo — enter it yourself";
      } else if (!wasTouched) {
        numberGuessHint.textContent = "";
      }
    }

    appendSharedFields(dialog);

    const consentField = buildConsentField();
    dialog.appendChild(consentField);
    const consentCheckbox = consentField.querySelector(".f-consent");

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "modal-submit";
    submitBtn.textContent = "submit";
    dialog.appendChild(submitBtn);

    const status = document.createElement("div");
    status.className = "upload-status";
    status.setAttribute("role", "status");
    dialog.appendChild(status);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector(".f-submitter");

    function syncSubmitEnabled() {
      const numbers = parseNumberList(numberInput.value);
      submitBtn.disabled = !(numbers.length && stagedFile && nameInput.value.trim() && consentCheckbox.checked);
    }
    numberInput.addEventListener("input", syncSubmitEnabled);
    nameInput.addEventListener("input", syncSubmitEnabled);
    consentCheckbox.addEventListener("change", syncSubmitEnabled);

    submitBtn.addEventListener("click", () => {
      const numbers = parseNumberList(numberInput.value);
      if (!numbers.length || !stagedFile || !nameInput.value.trim() || !consentCheckbox.checked) return;
      const dt = new DataTransfer();
      dt.items.add(stagedFile);
      submitPhotos(dt.files, numbers, readSharedFields(dialog), status).then((ok) => {
        if (ok) {
          stagedFile = null;
          closeModal();
        }
      });
    });

    function openModal() {
      // the number field is the one thing that never carries over between
      // submissions — everything else remembers what was typed last time.
      numberInput.value = findFirstEmpty() || "";
      numberTouched = false;
      numberGuessHint.textContent = "";
      fileInput.value = "";
      stagedFile = null;
      applyFormMemory(dialog);
      dialog.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.checked = true;
        cb.dispatchEvent(new Event("change"));
      });
      status.textContent = "";
      status.className = "upload-status";
      syncSubmitEnabled();
      overlay.hidden = false;
      numberInput.focus();
    }

    function closeModal() {
      overlay.hidden = true;
    }

    closeLink.addEventListener("click", (e) => { e.preventDefault(); closeModal(); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) closeModal();
    });

    return { openModal, closeModal };
  }

  // ---- "report a bug" ----
  // Split in two and joined at runtime so the address isn't sitting in the
  // page source for address-harvesting crawlers to scrape. Fill these in
  // with a project-only address — not a personal or work inbox.
  const BUG_EMAIL_USER = "reportnumbers";
  const BUG_EMAIL_DOMAIN = "pterodactyl.supplies";

  const GITHUB_ISSUES_URL =
    "https://github.com/pterodactylsupplies/pterodactylsupplies.github.io/issues/new";

  function wireBugReport() {
    const subject = "Give or Take 100 — bug report";
    // Pre-filled so reports arrive with the context that actually helps:
    // which page, which device. The person can delete any of it.
    const body = [
      "What happened:",
      "",
      "What you expected:",
      "",
      "---",
      `Page: ${location.href}`,
      `Browser: ${navigator.userAgent}`,
    ].join("\n");

    const mailLink = document.getElementById("report-bug");
    if (mailLink) {
      const to = BUG_EMAIL_USER && BUG_EMAIL_DOMAIN ? `${BUG_EMAIL_USER}@${BUG_EMAIL_DOMAIN}` : "";
      mailLink.href =
        `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }

    const ghLink = document.getElementById("report-github");
    if (ghLink) {
      ghLink.href =
        `${GITHUB_ISSUES_URL}?title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }
  }
  wireBugReport();
  // the pre-filled page URL should follow the visitor around the site
  window.addEventListener("hashchange", wireBugReport);

  // ---- boot ----
  window.addEventListener("hashchange", render);
  document.getElementById("home-link").addEventListener("click", () => {
    location.hash = "";
  });

  modalEls = buildModal();
  const addBtn = document.getElementById("add-number-btn");
  if (addBtn) addBtn.addEventListener("click", modalEls.openModal);

  loadPhotos()
    .then(render)
    .catch((err) => {
      app.innerHTML = `<p class="error">Couldn't reach the picture API (${err.message}).<br>Check API_BASE in config.js.</p>`;
    });
})();
