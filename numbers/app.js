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

  // ---- HEIC ----
  // HEIC keeps EXIF as an item inside the ISO-BMFF "meta" box: "iinf" names
  // the items, "iloc" says where each one's bytes live. Walk both to find the
  // Exif item. iPhones shoot HEIC by default, so without this every iPhone
  // photo arrives with no location at all.

  function findBox(view, start, end, type) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const boxType = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5),
        view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      let headerSize = 8;
      if (size === 1) {
        // 64-bit length; anything needing the high word isn't a photo
        if (offset + 16 > end || view.getUint32(offset + 8) !== 0) return null;
        size = view.getUint32(offset + 12);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset; // runs to the end of the file
      }
      if (size < headerSize) return null; // malformed — don't loop forever
      if (boxType === type) {
        return { dataStart: offset + headerSize, end: Math.min(offset + size, end) };
      }
      offset += size;
    }
    return null;
  }

  function findExifItemId(view, box) {
    const version = view.getUint8(box.dataStart);
    let offset = box.dataStart + 4; // past version/flags
    let count;
    if (version === 0) { count = view.getUint16(offset); offset += 2; }
    else { count = view.getUint32(offset); offset += 4; }

    for (let i = 0; i < count && offset + 12 <= box.end; i++) {
      const size = view.getUint32(offset);
      if (size < 8) return null;
      const infeVersion = view.getUint8(offset + 8);
      if (infeVersion >= 2) {
        const idSize = infeVersion === 2 ? 2 : 4;
        const idAt = offset + 12;
        const typeAt = idAt + idSize + 2; // past item_protection_index
        if (typeAt + 4 <= box.end) {
          const itemType = String.fromCharCode(
            view.getUint8(typeAt), view.getUint8(typeAt + 1),
            view.getUint8(typeAt + 2), view.getUint8(typeAt + 3)
          );
          if (itemType === "Exif") {
            return idSize === 2 ? view.getUint16(idAt) : view.getUint32(idAt);
          }
        }
      }
      offset += size;
    }
    return null;
  }

  function findItemExtent(view, box, itemId) {
    const version = view.getUint8(box.dataStart);
    let offset = box.dataStart + 4;
    const sizeByte = view.getUint8(offset);
    const offsetSize = sizeByte >> 4;
    const lengthSize = sizeByte & 0x0f;
    const nextByte = view.getUint8(offset + 1);
    const baseOffsetSize = nextByte >> 4;
    const indexSize = version >= 1 ? (nextByte & 0x0f) : 0;
    offset += 2;

    let itemCount;
    if (version < 2) { itemCount = view.getUint16(offset); offset += 2; }
    else { itemCount = view.getUint32(offset); offset += 4; }

    const readN = (at, n) => {
      if (n === 0) return 0;
      if (n === 2) return view.getUint16(at);
      if (n === 4) return view.getUint32(at);
      if (n === 8) return view.getUint32(at) !== 0 ? NaN : view.getUint32(at + 4);
      return NaN;
    };

    for (let i = 0; i < itemCount && offset < box.end; i++) {
      let id;
      if (version < 2) { id = view.getUint16(offset); offset += 2; }
      else { id = view.getUint32(offset); offset += 4; }
      if (version >= 1) offset += 2; // construction_method
      offset += 2; // data_reference_index
      const baseOffset = readN(offset, baseOffsetSize);
      offset += baseOffsetSize;
      const extentCount = view.getUint16(offset);
      offset += 2;
      for (let e = 0; e < extentCount; e++) {
        offset += indexSize;
        const extentOffset = readN(offset, offsetSize);
        offset += offsetSize;
        const extentLength = readN(offset, lengthSize);
        offset += lengthSize;
        if (id === itemId && e === 0) {
          const at = baseOffset + extentOffset;
          if (!Number.isFinite(at) || !Number.isFinite(extentLength)) return null;
          return { offset: at, length: extentLength };
        }
      }
    }
    return null;
  }

  function findHeicExifExtent(view) {
    const meta = findBox(view, 0, view.byteLength, "meta");
    if (!meta) return null;
    // meta is a FullBox — 4 bytes of version/flags before its children
    const start = meta.dataStart + 4;
    const iinf = findBox(view, start, meta.end, "iinf");
    const iloc = findBox(view, start, meta.end, "iloc");
    if (!iinf || !iloc) return null;
    const itemId = findExifItemId(view, iinf);
    if (itemId == null) return null;
    return findItemExtent(view, iloc, itemId);
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

    if (kind === "heic" || kind === "bmff") {
      let extent;
      try {
        extent = findHeicExifExtent(view);
      } catch {
        return { reason: "unreadable" }; // truncated or unusual box layout
      }
      if (!extent) return { reason: "no-exif" };

      let block = view;
      let at = extent.offset;
      if (at + Math.min(extent.length, 16) > view.byteLength) {
        // the Exif item sits past our opening window — read just that range
        try {
          const buf = await file.slice(at, at + extent.length).arrayBuffer();
          block = new DataView(buf);
          at = 0;
        } catch {
          return { reason: "unreadable" };
        }
      }
      // the item's payload starts with a 4-byte offset to the TIFF header
      if (at + 4 > block.byteLength) return { reason: "no-exif" };
      const tiffStart = at + 4 + block.getUint32(at);
      if (tiffStart + 8 > block.byteLength) return { reason: "no-exif" };
      return parseTiffExif(block, tiffStart);
    }

    if (kind !== "jpeg") return { reason: "no-exif" }; // PNG/WebP carry none

    const exifOffset = findExifOffset(view);
    if (exifOffset == null || exifOffset + 8 > view.byteLength) return { reason: "no-exif" };
    return parseTiffExif(view, exifOffset);
  }

  // The TIFF block that both JPEG's APP1 segment and HEIC's Exif item wrap.
  // `exifOffset` points at the byte-order mark ("II" or "MM").
  function parseTiffExif(view, exifOffset) {
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
  // Strips the administrative noise words so two labels can be compared for
  // "is this just the city's name again?" — "Tel Aviv" vs "Tel Aviv District".
  function bareName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, " ")
      .replace(/\b(district|subdistrict|sub|county|province|region|municipality|governorate|oblast|krai|prefecture|department|metropolitan|greater|city|area)\b/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Deliberately an exact match once the noise words are gone, not a
  // substring test: "Ile-de-France" contains "France" without being it.
  function saysSameThing(a, b) {
    const x = bareName(a);
    const y = bareName(b);
    return Boolean(x) && x === y;
  }

  // Town → state/province → country. Counties and districts are deliberately
  // left out: they're rarely how anyone describes where they were, and they
  // produce things like "Tel Aviv, Tel Aviv Subdistrict, Tel-Aviv District,
  // Israel". A state/province is kept only when it adds something the town
  // name doesn't already say — so US and Canadian places keep theirs, while
  // city-states and same-named regions don't repeat themselves.
  function placeLabel(addr) {
    const town =
      addr.city || addr.town || addr.village || addr.municipality || addr.hamlet || "";
    const region = addr.state || addr.province || addr.region || "";
    const country = addr.country || "";

    // With no town to anchor on, the next level up is the most useful thing
    // we have rather than nothing at all.
    const primary = town || addr.county || addr.state_district || region;

    const parts = [];
    const add = (value) => {
      if (!value) return;
      if (parts.some((existing) => saysSameThing(existing, value))) return;
      parts.push(value);
    };
    add(primary);
    add(region);
    add(country);
    return parts.join(", ");
  }

  // Returns {label} on success, or {error} naming the stage that failed, so
  // the form can say "the lookup broke" instead of implying the photo had no
  // location. Nominatim allows one request a second per IP — and phones share
  // an IP behind carrier NAT — so a throttle here is not unusual.
  async function reverseGeocodeOnce(lat, lon) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lon}&zoom=10`,
        { headers: { Accept: "application/json" } }
      );
      if (res.status === 429 || res.status === 403) return { error: "busy" };
      if (!res.ok) return { error: "failed" };
      const data = await res.json();
      const label = placeLabel(data.address || {});
      return label ? { label } : { error: "unnamed" };
    } catch {
      return { error: "offline" };
    }
  }

  async function reverseGeocode(lat, lon) {
    const first = await reverseGeocodeOnce(lat, lon);
    if (first.label || first.error === "unnamed") return first;
    // One retry, paced past Nominatim's one-per-second limit. Worth it: the
    // coordinates are good, and a throttle or a dropped request on a phone is
    // exactly the transient case that used to read as "no location".
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return reverseGeocodeOnce(lat, lon);
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
  // Says which stage failed rather than four ways of saying "no location".
  // The distinction that matters: "this photo has none" is the person's to
  // fix, "the lookup broke" is ours — and they used to read identically.
  function locationHint(exif, geo) {
    if (geo) {
      // coordinates were read fine; the place-name lookup is what failed
      if (geo.error === "busy") {
        return "the place lookup is rate-limited right now — type it in";
      }
      if (geo.error === "offline") {
        return "couldn't reach the place lookup — type it in";
      }
      if (geo.error === "unnamed") {
        return "this photo's coordinates have no place name — type it in";
      }
      return "read the coordinates, but the place lookup failed — type it in";
    }
    if (exif.reason === "no-gps") {
      return "this photo has no location saved in it — type it in";
    }
    if (exif.reason === "no-exif") {
      return "this photo carries no location data — type it in";
    }
    if (exif.reason === "unreadable") {
      return "couldn't read this photo's data — type it in";
    }
    return "couldn't find a location — type it in";
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
      let geo = null;
      if (exif.lat != null && exif.lon != null) {
        locInput.value = "looking up…";
        geo = await reverseGeocode(exif.lat, exif.lon);
        locInput.value = geo.label || "";
      }
      if (!locInput.value) {
        autoUncheck(locCheckbox);
        locInput.placeholder = locationHint(exif, geo);
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
    // full-bleed is opt-in per page; cleared here so it can't leak between views
    document.body.classList.remove("view-wide");
    // the grid lab dresses the whole page — undo that when leaving it
    for (const cls of [...document.body.classList]) {
      if (cls.startsWith("lab-")) document.body.classList.remove(cls);
    }
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
      // the main wall: full window, pictures up to 1000px, gutter fixed wide,
      // numbers hidden until asked for
      setView("all");
      renderAll({
        wide: true,
        numbersToggle: true,
        maxWidth: 1000,
        fixedGap: 150,
        hideSizeValue: true,
      });
    } else if (location.hash === "#/all-develop") {
      // the same wall with both sliders exposed, kept to experiment on
      setView("all");
      renderAll({
        wide: true,
        gapControl: true,
        numbersToggle: true,
        maxWidth: 1000,
        maxGap: 300,
      });
    } else if (location.hash === "#/all-board") {
      setView("all");
      document.body.classList.add("view-wide");
      renderBoard();
    } else if (location.hash === "#/all-old") {
      // the original capped wall with full details, kept for reference
      setView("all");
      renderAll();
    } else if (location.hash === "#/all-plain") {
      setView("all");
      renderAll({ mode: "plain" });
    } else if (location.hash === "#/all-numbers") {
      setView("all");
      renderAll({ mode: "numbers" });
    } else if (location.hash === "#/all-numbers-wide") {
      setView("all");
      renderAll({ mode: "numbers", wide: true });
    } else if (location.hash === "#/all-numbers-wide-gap") {
      setView("all");
      renderAll({ mode: "numbers", wide: true, gapControl: true });
    } else if (location.hash === "#/grid-lab") {
      setView("grid");
      renderGridLab();
    } else if (location.hash === "#/exif-check") {
      setView("terms");
      renderExifCheck();
    } else if (location.hash === "#/people") {
      setView("all");
      renderPeople();
    } else if (location.hash === "#/misc") {
      // misc is a number page in all but name, so it runs full window too
      setView("misc");
      document.body.classList.add("view-wide");
      renderMisc();
    } else {
      // Number pages run full window by default. "#/42/narrow" keeps the old
      // capped layout; "#/42/wide" still works, since links to it exist.
      const suffixed = location.hash.match(/^#\/(\d{1,3})\/(wide|narrow)$/);
      const n = suffixed ? Number(suffixed[1]) : currentNumber();
      if (n && n >= 1 && n <= 100) {
        const narrow = suffixed ? suffixed[2] === "narrow" : false;
        setView("detail");
        if (!narrow) document.body.classList.add("view-wide");
        renderDetail(n, narrow);
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
    html += ` &middot; <a href="#/all"><strong>${total}</strong> pics</a>`;
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

  // ---- grid lab: the same 100 cells, with the look-and-feel exposed ----
  // A place to try cell sizes, gutters, frames, background patterns and
  // fonts without touching the real grid. Choices are remembered.
  const GRID_LAB_KEY = "numbersGallery.gridLab";
  const NATIVE_FRAME_STYLES = [
    "solid", "double", "dashed", "dotted", "groove", "ridge", "inset", "outset",
  ];
  const TWO_TONE_FRAME_STYLES = [
    "outset-bw", "inset-bw", "groove-bw", "ridge-bw",
    "outset-grey", "inset-grey", "groove-grey", "ridge-grey",
  ];
  const LAB_PATTERNS = [
    ["fine-dots", "fine dots"],
    ["none", "none"],
    ["dots", "large dots"],
    ["grid", "graph paper"],
    ["cross", "crosses"],
    ["diagonal", "diagonal lines"],
  ];

  function renderGridLab() {
    document.title = "numberwang — grid lab";
    setWordmark("The Game Where We Collect Numbers");

    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(GRID_LAB_KEY)) || {};
    } catch {
      stored = {};
    }
    const prefs = Object.assign(
      // defaults mirror the live site, so the lab opens on what you'd see
      {
        cell: 90,
        gap: 50,
        frames: true,
        frameWidth: 1,
        frameStyle: "solid",
        pattern: "fine-dots",
        font: "serif",
      },
      stored
    );
    const savePrefs = () => {
      try {
        localStorage.setItem(GRID_LAB_KEY, JSON.stringify(prefs));
      } catch {
        /* not worth failing the page over */
      }
    };

    const section = document.createElement("section");
    section.className = "grid-section lab-section";

    const controls = document.createElement("div");
    controls.className = "all-controls lab-controls";

    // --- sliders, each with a live readout ---
    const makeSlider = (labelText, key, min, max, step) => {
      const label = document.createElement("label");
      label.appendChild(document.createTextNode(labelText));
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(prefs[key]);
      label.appendChild(range);
      const value = document.createElement("span");
      value.className = "range-value";
      value.textContent = `${prefs[key]}px`;
      label.appendChild(value);
      range.addEventListener("input", () => {
        prefs[key] = Number(range.value);
        value.textContent = `${prefs[key]}px`;
        savePrefs();
        apply();
      });
      controls.appendChild(label);
      return range;
    };
    makeSlider("cell size", "cell", 40, 400, 5);
    makeSlider("gap", "gap", 0, 80, 1);

    // --- frames on/off ---
    const framesLabel = document.createElement("label");
    const framesBox = document.createElement("input");
    framesBox.type = "checkbox";
    framesBox.checked = Boolean(prefs.frames);
    framesLabel.appendChild(framesBox);
    framesLabel.appendChild(document.createTextNode(" frames"));
    controls.appendChild(framesLabel);
    framesBox.addEventListener("change", () => {
      prefs.frames = framesBox.checked;
      savePrefs();
      apply();
    });

    makeSlider("frame width", "frameWidth", 0, 400, 1);

    // --- frame style ---
    // "double" needs at least 3px to resolve into two lines, and groove and
    // ridge need a few px before they read as anything at all.
    //
    // The plain groove/ridge/inset/outset take their two tones from whatever
    // the browser derives off one colour, which lands on muddy greys. The
    // -bw and -grey entries set every side explicitly instead, so the pairing
    // is exactly black-and-white or black-and-grey.
    const frameLabel = document.createElement("label");
    frameLabel.appendChild(document.createTextNode("frame style"));
    const frameSel = document.createElement("select");
    for (const [value, text] of [
      ["solid", "solid"],
      ["double", "double line"],
      ["dashed", "dashed"],
      ["dotted", "dotted"],
      ["groove", "groove"],
      ["ridge", "ridge"],
      ["inset", "inset"],
      ["outset", "outset"],
      ["outset-bw", "outset — black/white"],
      ["inset-bw", "inset — black/white"],
      ["groove-bw", "groove — black/white"],
      ["ridge-bw", "ridge — black/white"],
      ["outset-grey", "outset — black/grey"],
      ["inset-grey", "inset — black/grey"],
      ["groove-grey", "groove — black/grey"],
      ["ridge-grey", "ridge — black/grey"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      frameSel.appendChild(opt);
    }
    frameSel.value = prefs.frameStyle;
    frameLabel.appendChild(frameSel);
    controls.appendChild(frameLabel);
    frameSel.addEventListener("change", () => {
      prefs.frameStyle = frameSel.value;
      savePrefs();
      apply();
    });

    // --- background pattern ---
    const patternLabel = document.createElement("label");
    patternLabel.appendChild(document.createTextNode("background"));
    const patternSel = document.createElement("select");
    for (const [value, text] of LAB_PATTERNS) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      patternSel.appendChild(opt);
    }
    patternSel.value = prefs.pattern;
    patternLabel.appendChild(patternSel);
    controls.appendChild(patternLabel);
    patternSel.addEventListener("change", () => {
      prefs.pattern = patternSel.value;
      savePrefs();
      apply();
    });

    // --- font ---
    const fontLabel = document.createElement("label");
    fontLabel.appendChild(document.createTextNode("font"));
    const fontSel = document.createElement("select");
    for (const [value, text] of [["serif", "Times"], ["mono", "monospace"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      fontSel.appendChild(opt);
    }
    fontSel.value = prefs.font;
    fontLabel.appendChild(fontSel);
    controls.appendChild(fontLabel);
    fontSel.addEventListener("change", () => {
      prefs.font = fontSel.value;
      savePrefs();
      apply();
    });

    section.appendChild(controls);

    const grid = document.createElement("div");
    grid.className = "number-grid";
    for (let i = 1; i <= 100; i++) {
      grid.appendChild(buildCell(String(i), photosByNumber[i] || [], `#/${i}`));
    }
    grid.appendChild(buildCell("misc", miscEntries(), "#/misc"));
    section.appendChild(grid);

    function apply() {
      grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${prefs.cell}px, 1fr))`;
      grid.style.gap = `${prefs.gap}px`;

      section.classList.toggle("lab-noframes", !prefs.frames);
      section.style.setProperty("--lab-frame-width", `${prefs.frameWidth}px`);
      // Native border-styles go straight through as a value; the two-tone
      // ones aren't real CSS keywords, so they ride on a class instead and
      // fall back to solid for the underlying border.
      const isNative = NATIVE_FRAME_STYLES.includes(prefs.frameStyle);
      section.style.setProperty("--lab-frame-style", isNative ? prefs.frameStyle : "solid");
      for (const value of TWO_TONE_FRAME_STYLES) {
        section.classList.toggle(`lab-frame-${value}`, prefs.frameStyle === value);
      }

      // Background and font dress the whole page, not just the grid — so
      // they go on <body>, and setView strips them when you navigate away.
      for (const [value] of LAB_PATTERNS) {
        document.body.classList.toggle(`lab-bg-${value}`, prefs.pattern === value);
      }
      document.body.classList.toggle("lab-font-mono", prefs.font === "mono");
      document.body.classList.toggle("lab-font-serif", prefs.font === "serif");
    }
    apply();

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

  // What to print for a link: host plus path, so a profile reads
  // "instagram.com/dima.photos" rather than a bare "instagram.com" that
  // doesn't say whose account it is. Only the scheme and a leading www are
  // dropped; long paths are truncated rather than hidden.
  const MAX_LABEL = 42;

  function contactLabel(href, raw) {
    if (href.startsWith("mailto:")) return href.slice(7);
    let url;
    try {
      url = new URL(href);
    } catch {
      return raw;
    }
    const host = url.host.replace(/^www\./i, "");
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
    if (!path) return host;

    const full = `${host}/${path}`;
    return full.length > MAX_LABEL ? `${full.slice(0, MAX_LABEL - 1)}…` : full;
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
      return { href, label: contactLabel(href, value) };
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

  function renderDetail(n, narrow = false) {
    // prev/next keep whichever width you're browsing in; wide is the plain
    // "#/42" form now, so only the narrow variant needs a suffix
    const numberHref = (x) => (narrow ? `#/${x}/narrow` : `#/${x}`);
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
      <a href="${numberHref(prevN)}">&larr; ${prevN}</a>
      <div class="detail-center">
        <div class="detail-number">${n}</div>
        <div class="detail-meta">${photos.length} picture${photos.length === 1 ? "" : "s"} on file</div>
      </div>
      <a href="${numberHref(nextN)}">${nextN} &rarr;</a>`;
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
          favorites: new Set(),
          comments: [],
        };
        people.set(key, person);
      }
      person.names.add(name);
      if (p.contact) person.contacts.add(p.contact);
      if (p.location) person.locations.add(p.location);
      if (p.favoriteNumber) person.favorites.add(p.favoriteNumber.trim());
      if (p.comments) person.comments.push(p.comments.trim());
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

  // ---- #/exif-check: unlisted page that dumps what a photo actually
  // contains. Reads only; nothing is uploaded. Exists because "no location
  // in this photo" has several causes that look identical from outside, and
  // guessing between them from a description has not worked.

  function listJpegSegments(view) {
    const found = [];
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffd9 || marker === 0xffda) { found.push("SOS/EOI"); break; }
      const size = view.getUint16(offset + 2);
      if (size < 2) break;
      const low = marker & 0xff;
      found.push(low >= 0xe0 && low <= 0xef ? `APP${low - 0xe0}(${size}b)` : `FF${low.toString(16)}`);
      offset += 2 + size;
    }
    return found;
  }

  function describeTiff(view, start) {
    const out = {};
    try {
      const little = view.getUint16(start) === 0x4949;
      out["byte order"] = little ? "little-endian (II)" : "big-endian (MM)";
      const get16 = (o) => view.getUint16(o, little);
      const get32 = (o) => view.getUint32(o, little);
      const readIFD = (at) => {
        const entries = {};
        const count = get16(at);
        for (let i = 0; i < count; i++) {
          const eo = at + 2 + i * 12;
          entries[get16(eo)] = { type: get16(eo + 2), num: get32(eo + 4), valueOffset: eo + 8 };
        }
        return entries;
      };
      const rational = (o) => {
        const n = get32(o), d = get32(o + 4);
        return d ? `${n}/${d}` : `${n}/0`;
      };
      const readStr = (e) => {
        const at = e.num <= 4 ? e.valueOffset : start + get32(e.valueOffset);
        let s = "";
        for (let i = 0; i < e.num - 1; i++) s += String.fromCharCode(view.getUint8(at + i));
        return s.replace(/\0/g, "").trim();
      };

      const ifd0 = readIFD(start + get32(start + 4));
      const tags = Object.keys(ifd0).map(Number);
      out["IFD0 tags"] = `${tags.length} — ${tags.map((t) => "0x" + t.toString(16)).join(" ")}`;
      if (ifd0[0x010f]) out["camera make"] = readStr(ifd0[0x010f]);
      if (ifd0[0x0110]) out["camera model"] = readStr(ifd0[0x0110]);
      if (ifd0[0x0132]) out["date/time"] = readStr(ifd0[0x0132]);

      // The decisive line: is the GPS pointer there at all?
      out["GPS pointer (0x8825)"] = ifd0[0x8825] ? "PRESENT" : "ABSENT";
      if (ifd0[0x8825]) {
        const gps = readIFD(start + get32(ifd0[0x8825].valueOffset));
        const gpsTags = Object.keys(gps).map(Number);
        out["GPS tags"] = `${gpsTags.length} — ${gpsTags.join(" ")}`;
        const rats = (e) => {
          const at = start + get32(e.valueOffset);
          const o = [];
          for (let i = 0; i < e.num; i++) o.push(rational(at + i * 8));
          return o.join("  ");
        };
        out["GPSLatitudeRef (1)"] = gps[1] ? `"${readStr(gps[1])}"` : "MISSING";
        out["GPSLatitude (2)"] = gps[2] ? rats(gps[2]) : "MISSING";
        out["GPSLongitudeRef (3)"] = gps[3] ? `"${readStr(gps[3])}"` : "MISSING";
        out["GPSLongitude (4)"] = gps[4] ? rats(gps[4]) : "MISSING";
      }
    } catch (err) {
      out["parse error"] = String(err && err.message);
    }
    return out;
  }

  async function diagnoseExif(file) {
    const out = {
      "file name": file.name || "(none)",
      "reported type": file.type || "(empty)",
      "size": `${file.size} bytes (${(file.size / 1024 / 1024).toFixed(2)} MB)`,
    };

    let view;
    try {
      view = new DataView(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer());
    } catch (err) {
      out["read error"] = String(err && err.message);
      return out;
    }
    out["bytes examined"] = view.byteLength;

    const kind = sniffImageKind(view);
    out["sniffed format"] = kind;

    let block = view;
    let tiffStart = null;
    if (kind === "jpeg") {
      out["JPEG segments"] = listJpegSegments(view).join(" ") || "(none)";
      tiffStart = findExifOffset(view);
    } else if (kind === "heic" || kind === "bmff") {
      let extent = null;
      try {
        extent = findHeicExifExtent(view);
      } catch (err) {
        out["HEIC walk error"] = String(err && err.message);
      }
      out["HEIC Exif item"] = extent
        ? `offset ${extent.offset}, ${extent.length} bytes`
        : "not found";
      if (extent) {
        let at = extent.offset;
        if (at + Math.min(extent.length, 16) > view.byteLength) {
          try {
            block = new DataView(await file.slice(at, at + extent.length).arrayBuffer());
            at = 0;
            out["Exif item"] = "read separately (past the 2 MB window)";
          } catch (err) {
            out["Exif item read error"] = String(err && err.message);
            return out;
          }
        }
        tiffStart = at + 4 + block.getUint32(at);
      }
    }

    if (tiffStart == null) {
      out["EXIF block"] = "NOT FOUND";
    } else {
      out["EXIF block"] = `found at byte ${tiffStart}`;
      Object.assign(out, describeTiff(block, tiffStart));
    }

    const parsed = await readExif(file);
    out["--- what the form does with it ---"] = "";
    out["latitude"] = parsed.lat == null ? "(none)" : String(parsed.lat);
    out["longitude"] = parsed.lon == null ? "(none)" : String(parsed.lon);
    out["taken at"] = parsed.takenAt || "(none)";
    out["verdict"] = parsed.reason || "usable location found";
    return out;
  }

  function renderExifCheck() {
    document.title = "numberwang — exif check";
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
    heading.textContent = "what's actually in this photo";
    section.appendChild(heading);

    const blurb = document.createElement("p");
    blurb.textContent =
      "Pick a photo to see what data it carries. Nothing is uploaded or saved — " +
      "the file is read in your browser and thrown away.";
    section.appendChild(blurb);

    const input = document.createElement("input");
    input.type = "file";
    input.className = "exif-check-input";
    // deliberately unfiltered: whichever picker this opens is part of what
    // we're testing, and the answer may differ between them
    section.appendChild(input);

    const actions = document.createElement("p");
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mast-cta";
    copyBtn.textContent = "copy result";
    copyBtn.hidden = true;
    actions.appendChild(copyBtn);
    section.appendChild(actions);

    const out = document.createElement("pre");
    out.className = "exif-check-out";
    section.appendChild(out);

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      out.textContent = "reading…";
      copyBtn.hidden = true;
      let report;
      try {
        report = await diagnoseExif(file);
      } catch (err) {
        out.textContent = `failed: ${err && err.message}`;
        return;
      }
      const width = Math.max(...Object.keys(report).map((k) => k.length));
      out.textContent = Object.entries(report)
        .map(([k, v]) => (v === "" ? k : `${k.padEnd(width)}  ${v}`))
        .join("\n");
      copyBtn.hidden = false;
    });

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(out.textContent);
        copyBtn.textContent = "copied";
        setTimeout(() => { copyBtn.textContent = "copy result"; }, 1500);
      } catch {
        // clipboard blocked — select it instead so a long-press can copy
        const range = document.createRange();
        range.selectNodeContents(out);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copyBtn.textContent = "selected — long-press to copy";
      }
    });

    app.replaceChildren(section);
    renderProgress();
  }

  // Shared with admin.html, so unlocking either page unlocks the other.
  const ADMIN_TOKEN_KEY = "numbersAdmin.token";

  // Checked against the worker rather than locally, so a wrong password is
  // actually refused. This gates the page, not the data: /api/photos is
  // public, so it stops casual browsing, not a determined reader.
  async function adminTokenValid(token) {
    if (!token) return false;
    try {
      const res = await fetch(`${API}/api/verify-admin`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function renderPeople() {
    document.title = "numberwang — people";
    setWordmark("The Game Where We Collect Numbers");

    const pending = document.createElement("p");
    pending.className = "loading";
    pending.textContent = "Checking…";
    app.replaceChildren(pending);
    renderProgress();

    adminTokenValid(sessionStorage.getItem(ADMIN_TOKEN_KEY) || "").then((ok) => {
      // the check is async — don't stomp a view they've navigated to since
      if (location.hash !== "#/people") return;
      if (ok) renderPeopleTable();
      else renderPeopleLock();
    });
  }

  function peopleSection() {
    const section = document.createElement("section");
    section.className = "detail-section";
    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);
    return section;
  }

  function renderPeopleLock() {
    const section = peopleSection();

    const heading = document.createElement("h2");
    heading.className = "terms-heading";
    heading.textContent = "people";
    section.appendChild(heading);

    const form = document.createElement("form");
    form.className = "people-lock";

    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "admin token";
    input.autocomplete = "off";
    form.appendChild(input);

    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "unlock";
    form.appendChild(button);

    const err = document.createElement("p");
    err.className = "people-lock-err";
    form.appendChild(err);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        err.textContent = "Enter the admin token.";
        return;
      }
      button.disabled = true;
      err.textContent = "checking…";
      const ok = await adminTokenValid(value);
      button.disabled = false;
      if (!ok) {
        err.textContent = "That token isn't right.";
        input.select();
        return;
      }
      sessionStorage.setItem(ADMIN_TOKEN_KEY, value);
      if (location.hash === "#/people") renderPeopleTable();
    });

    section.appendChild(form);
    app.replaceChildren(section);
    renderProgress();
    input.focus();
  }

  function renderPeopleTable() {
    const section = peopleSection();

    const people = groupPeople();
    const totalPhotos = people.reduce((sum, person) => sum + person.count, 0);

    const heading = document.createElement("h2");
    heading.className = "terms-heading";
    heading.textContent = `${people.length} ${people.length === 1 ? "person" : "people"}, ${totalPhotos} pictures`;
    const lockLink = document.createElement("a");
    lockLink.className = "people-lock-link";
    lockLink.href = "#/people";
    lockLink.textContent = "[lock]";
    lockLink.addEventListener("click", (event) => {
      event.preventDefault();
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      renderPeopleLock();
    });
    heading.appendChild(lockLink);
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
    [
      "person",
      "method no.",
      "favorite no.",
      "contact",
      "pictures",
      "numbers",
      "places",
      "first",
      "latest",
      "comments",
    ].forEach((label) => {
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

      // free text, so it can hold "2^5" as readily as "32"
      const favoriteCell = document.createElement("td");
      favoriteCell.className = "num";
      favoriteCell.textContent = [...person.favorites].join(", ") || "—";
      tr.appendChild(favoriteCell);

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

      const placesCell = document.createElement("td");
      placesCell.className = "wrap";
      placesCell.textContent = [...person.locations].join(" · ") || "—";
      tr.appendChild(placesCell);

      const firstCell = document.createElement("td");
      firstCell.textContent = person.first ? new Date(person.first).toLocaleDateString() : "—";
      tr.appendChild(firstCell);

      const lastCell = document.createElement("td");
      lastCell.textContent = person.last ? new Date(person.last).toLocaleDateString() : "—";
      tr.appendChild(lastCell);

      const commentsCell = document.createElement("td");
      commentsCell.className = "wrap";
      commentsCell.textContent = person.comments.join(" · ") || "—";
      tr.appendChild(commentsCell);

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

  // The numbers a picture is filed under, each linking to its page.
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

  // Tooltip text for the quiet walls. Native title tooltips honour newlines,
  // so this reads as three lines rather than one long run:
  //   4 Sasha (100) @handle
  //   found 3 Oct 2021
  //   published 2 days ago
  function plainTooltip(p) {
    const head = [p.numbers.join(", "), p.submitter || "anonymous"];
    if (p.theirNumber) head.push(`(${p.theirNumber})`);
    const contact = contactDisplay(p.contact);
    if (contact) head.push(contact.label || contact.text);

    const lines = [head.join(" ")];
    if (p.foundAt) lines.push(`found ${formatFoundAt(p.foundAt)}`);
    lines.push(`published ${relativeTime(p.uploaded)}`);
    return lines.join("\n");
  }

  // A picture with nothing written under it — the details live in the
  // tooltip instead. With `withNumbers`, the numbers alone appear below the
  // picture as links, and nothing else.
  function buildPlainItem(p, withNumbers = false) {
    const item = document.createElement("div");
    item.className = "gallery-item gallery-item-plain";

    const link = document.createElement("a");
    link.href = imgUrl(p.key);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = plainTooltip(p);

    const img = document.createElement("img");
    img.loading = "lazy";
    // Short alt: enough for a screen reader to identify the picture, but it
    // won't splash the contributor's details across the page if the image
    // fails to load — the full summary stays in the tooltip.
    img.alt = `Picture of ${p.numbers.join(", ")}`;
    img.src = imgUrl(p.key);
    link.appendChild(img);
    item.appendChild(link);

    if (withNumbers) {
      const caption = document.createElement("div");
      caption.className = "gallery-caption";
      caption.appendChild(numbersCaption(p));
      item.appendChild(caption);
    }
    return item;
  }

  // ---- "board": the same pictures, but freely draggable ----
  // Positions are per-browser, keyed by photo, so an arrangement survives a
  // reload. Anything never dragged simply flows in reading order.
  const BOARD_KEY = "numbersGallery.boardLayout";

  function loadBoardLayout() {
    try {
      return JSON.parse(localStorage.getItem(BOARD_KEY)) || {};
    } catch {
      return {};
    }
  }

  function renderBoard() {
    document.title = "numberwang — board";
    setWordmark("The Game Where We Collect Numbers");

    const prefs = Object.assign({ width: 220, showNumbers: false }, loadAllPrefs());
    const savePrefs = () => localStorage.setItem(ALL_PREFS_KEY, JSON.stringify(prefs));
    const layout = loadBoardLayout();
    const saveLayout = () => {
      try {
        localStorage.setItem(BOARD_KEY, JSON.stringify(layout));
      } catch {
        /* storage full or blocked — the arrangement just won't persist */
      }
    };

    const entries = allEntries();

    const section = document.createElement("section");
    section.className = "detail-section";

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← back to grid";
    section.appendChild(back);

    const controls = document.createElement("div");
    controls.className = "all-controls";

    const countEl = document.createElement("span");
    countEl.textContent = `${entries.length} picture${entries.length === 1 ? "" : "s"}`;
    controls.appendChild(countEl);

    const sizeLabel = document.createElement("label");
    sizeLabel.appendChild(document.createTextNode("picture size"));
    const sizeRange = document.createElement("input");
    sizeRange.type = "range";
    sizeRange.min = "60";
    sizeRange.max = "1000";
    sizeRange.step = "10";
    sizeRange.value = String(Math.min(prefs.width, 1000));
    sizeLabel.appendChild(sizeRange);
    controls.appendChild(sizeLabel);

    const numbersLabel = document.createElement("label");
    const numbersBox = document.createElement("input");
    numbersBox.type = "checkbox";
    numbersBox.checked = Boolean(prefs.showNumbers);
    numbersLabel.appendChild(numbersBox);
    numbersLabel.appendChild(document.createTextNode(" show numbers"));
    controls.appendChild(numbersLabel);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "board-reset";
    resetBtn.textContent = "tidy up";
    controls.appendChild(resetBtn);

    const hint = document.createElement("span");
    hint.className = "board-hint";
    hint.textContent = "drag the pictures around";
    controls.appendChild(hint);

    section.appendChild(controls);

    const canvas = document.createElement("div");
    canvas.className = "board-canvas";
    section.appendChild(canvas);

    let topZ = 1;
    const nodes = new Map(); // key -> element

    // Where a picture sits if it has never been dragged: plain reading order.
    function flowPosition(index) {
      const gap = 24;
      const step = prefs.width + gap;
      const cols = Math.max(1, Math.floor((canvas.clientWidth || 1000) / step));
      return {
        x: (index % cols) * step,
        y: Math.floor(index / cols) * (prefs.width * 0.9 + gap),
      };
    }

    function place(el, pos) {
      el.style.left = `${Math.round(pos.x)}px`;
      el.style.top = `${Math.round(pos.y)}px`;
    }

    // The canvas is absolutely positioned inside, so it has no height of its
    // own — it has to be told how far its contents reach.
    function resizeCanvas() {
      let lowest = 0;
      for (const el of nodes.values()) {
        lowest = Math.max(lowest, el.offsetTop + el.offsetHeight);
      }
      canvas.style.height = `${lowest + 80}px`;
    }

    function buildItem(p, index) {
      const el = document.createElement("div");
      el.className = "board-item";
      el.style.width = `${prefs.width}px`;

      const link = document.createElement("a");
      link.href = imgUrl(p.key);
      link.target = "_blank";
      link.rel = "noopener";
      link.title = plainTooltip(p);
      link.draggable = false;

      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = `Picture of ${p.numbers.join(", ")}`;
      img.src = imgUrl(p.key);
      img.draggable = false; // otherwise the browser's own image-drag hijacks it
      link.appendChild(img);
      el.appendChild(link);

      if (prefs.showNumbers) {
        const caption = document.createElement("div");
        caption.className = "gallery-caption";
        caption.appendChild(numbersCaption(p));
        el.appendChild(caption);
      }

      place(el, layout[p.key] || flowPosition(index));

      // --- dragging ---
      let drag = null;
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        drag = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originX: el.offsetLeft,
          originY: el.offsetTop,
          moved: 0,
        };
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        el.style.zIndex = String(++topZ);
      });

      el.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        // kept inside the canvas so nothing can be dragged out of reach
        const maxX = Math.max(0, canvas.clientWidth - el.offsetWidth);
        place(el, {
          x: Math.min(Math.max(0, drag.originX + dx), maxX),
          y: Math.max(0, drag.originY + dy),
        });
      });

      let suppressClick = false;
      const finish = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        el.classList.remove("dragging");
        suppressClick = drag.moved > 3;
        if (suppressClick) {
          layout[p.key] = { x: el.offsetLeft, y: el.offsetTop };
          saveLayout();
          resizeCanvas();
        }
        drag = null;
      };
      el.addEventListener("pointerup", finish);
      el.addEventListener("pointercancel", finish);

      // a drag that happens to end on the picture shouldn't open it as well
      link.addEventListener("click", (e) => {
        if (suppressClick) {
          e.preventDefault();
          suppressClick = false;
        }
      });

      nodes.set(p.key, el);
      return el;
    }

    function build() {
      nodes.clear();
      canvas.replaceChildren();
      entries.forEach((p, i) => canvas.appendChild(buildItem(p, i)));
      // Measure straight away rather than waiting on a frame — a backgrounded
      // tab may not paint for a long time, and the canvas would sit at its
      // minimum height until something else nudged it.
      resizeCanvas();
      // then again as each picture arrives and gives the item its real height
      canvas.querySelectorAll("img").forEach((img) => {
        if (img.complete) return;
        img.addEventListener("load", resizeCanvas, { once: true });
        img.addEventListener("error", resizeCanvas, { once: true });
      });
    }

    sizeRange.addEventListener("input", () => {
      prefs.width = Number(sizeRange.value);
      savePrefs();
      for (const el of nodes.values()) el.style.width = `${prefs.width}px`;
      resizeCanvas();
    });

    numbersBox.addEventListener("change", () => {
      prefs.showNumbers = numbersBox.checked;
      savePrefs();
      build();
    });

    resetBtn.addEventListener("click", () => {
      for (const key of Object.keys(layout)) delete layout[key];
      saveLayout();
      build();
    });

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "no-photos";
      empty.textContent = "No pictures yet.";
      section.appendChild(empty);
    }

    app.replaceChildren(section);
    if (entries.length) build();
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

  // Options:
  //   mode          "full" (details under each picture) | "plain" (nothing)
  //                 | "numbers" (number links only)
  //   wide          drop the page's max-width, like the grid page
  //   gapControl    give the gutter its own slider instead of auto-scaling
  //   fixedGap      pin the gutter to one value, with no control at all
  //   numbersToggle offer a checkbox for showing the numbers under pictures
  //   maxWidth/maxGap  upper ends of the two sliders
  function renderAll(opts = {}) {
    const {
      mode = "full",
      wide = false,
      gapControl = false,
      fixedGap = null,
      numbersToggle = false,
      maxWidth = 480,
      maxGap = 60,
      hideSizeValue = false,
    } = opts;

    if (wide) document.body.classList.add("view-wide");
    document.title =
      mode === "full" ? "numberwang — all pictures" : "numberwang — pictures only";
    setWordmark("The Game Where We Collect Numbers");
    const mine = loadMyUploads();
    const prefs = Object.assign(
      { sort: "added", dir: "desc", width: 220, gap: 36, showNumbers: false },
      loadAllPrefs()
    );
    // With the checkbox in play the captions follow it; otherwise the page's
    // own mode decides.
    const effectiveMode = () =>
      numbersToggle ? (prefs.showNumbers ? "numbers" : "plain") : mode;
    const plain = () => effectiveMode() !== "full";
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
    // down to thumbnail size, in finer steps than before so the small end
    // is actually controllable rather than jumping in big increments
    sizeRange.min = "60";
    sizeRange.max = String(maxWidth);
    sizeRange.step = "10";
    // a stored size from a page with a lower ceiling shouldn't sit off-scale
    prefs.width = Math.min(prefs.width, maxWidth);
    sizeRange.value = String(prefs.width);
    sizeLabel.appendChild(sizeRange);
    const sizeValue = document.createElement("span");
    sizeValue.className = "range-value";
    sizeLabel.appendChild(sizeValue);
    controls.appendChild(sizeLabel);

    // Only on the page that asks for it: a gutter of your choosing, held
    // steady as the pictures resize rather than scaling along with them.
    let gapRange = null;
    let gapValue = null;
    if (gapControl) {
      const gapLabel = document.createElement("label");
      gapLabel.appendChild(document.createTextNode("gap"));
      gapRange = document.createElement("input");
      gapRange.type = "range";
      gapRange.min = "0";
      gapRange.max = String(maxGap);
      gapRange.step = "1";
      prefs.gap = Math.min(prefs.gap, maxGap);
      gapRange.value = String(prefs.gap);
      gapLabel.appendChild(gapRange);
      gapValue = document.createElement("span");
      gapValue.className = "range-value";
      gapLabel.appendChild(gapValue);
      controls.appendChild(gapLabel);
    }

    let numbersBox = null;
    if (numbersToggle) {
      const numbersLabel = document.createElement("label");
      numbersBox = document.createElement("input");
      numbersBox.type = "checkbox";
      numbersBox.checked = Boolean(prefs.showNumbers);
      numbersLabel.appendChild(numbersBox);
      numbersLabel.appendChild(document.createTextNode(" show numbers"));
      controls.appendChild(numbersLabel);
    }

    function showRangeValues() {
      sizeValue.textContent = hideSizeValue ? "" : `${prefs.width}px`;
      if (gapValue) gapValue.textContent = `${prefs.gap}px`;
    }
    showRangeValues();

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

    let items = [];
    let currentCols = 0;

    // n columns occupy n*width + (n-1)*gap, so the gutters have to come out
    // of the sum — ignoring them overshoots the count and squeezes the
    // pictures well below the requested size, badly so at wide gutters.
    function colCount() {
      const available = gallery.clientWidth || 0;
      const gap = currentGap();
      return Math.max(1, Math.floor((available + gap) / (prefs.width + gap)) || 1);
    }

    // With a gutter slider the value is taken literally and stays put as the
    // pictures resize. Without one, gutters shrink with the pictures — a
    // fixed 24px looks like a chasm between 60px thumbnails — but never grow
    // past the original spacing.
    function currentGap() {
      if (fixedGap != null) return fixedGap;
      if (gapControl) return prefs.gap;
      return Math.min(24, Math.max(6, Math.round(prefs.width / 9)));
    }

    function applyGap() {
      const gap = currentGap();
      gallery.style.gap = `${gap}px`;
      gallery.style.setProperty("--wall-gap", `${gap}px`);
    }

    // Deal items into N column stacks round-robin (item i → column i % N),
    // so the wall reads left-to-right, row by row.
    function layout() {
      applyGap();
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
      const current = effectiveMode();
      items = sorted.map((p, i) =>
        plain()
          ? buildPlainItem(p, current === "numbers")
          : buildGalleryItem(p, i, sorted.length, null, mine, { caption: numbersCaption(p) })
      );
      layout();
    }

    if (numbersBox) {
      numbersBox.addEventListener("change", () => {
        prefs.showNumbers = numbersBox.checked;
        savePrefs();
        rebuild();
      });
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
      showRangeValues();
      // gutters track the size on every nudge; the columns only need
      // re-dealing when the count actually changes
      if (colCount() !== currentCols) layout();
      else applyGap();
    });

    if (gapRange) {
      gapRange.addEventListener("input", () => {
        prefs.gap = Number(gapRange.value);
        savePrefs();
        showRangeValues();
        // a wider gutter leaves less room, so the column count can change
        if (colCount() !== currentCols) layout();
        else applyGap();
      });
    }

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

  // Number fields take digits only. Filtering as the person types — rather
  // than rejecting on submit — means a stray letter simply never appears, so
  // there is no error to explain. List fields also allow commas and spaces.
  function restrictToDigits(input, { list = false } = {}) {
    const banned = list ? /[^0-9,\s]/g : /[^0-9]/g;
    // A numeric keypad would be nicer on mobile, but iOS's numeric pad has no
    // comma key — so only single-value fields get one.
    if (!list) input.inputMode = "numeric";
    input.addEventListener("input", () => {
      const before = input.value;
      const cleaned = before.replace(banned, "");
      if (cleaned === before) return;
      // Keep the caret where they were typing instead of flinging it to the
      // end: count how many characters survived ahead of the old position.
      const caret = input.selectionStart ?? before.length;
      const kept = before.slice(0, caret).replace(banned, "").length;
      input.value = cleaned;
      input.setSelectionRange(kept, kept);
    });
  }

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
    const alsoField = buildTextField("also shows numbers", "f-also-numbers");
    restrictToDigits(alsoField.querySelector("input"), { list: true });
    block.appendChild(alsoField);
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

    // Deliberately unfiltered: a favorite number can be "2^5" and a method
    // number can be a joke. Only the fields that feed the grid are digits-only.
    container.appendChild(
      buildPairRow(
        buildTextField("favorite number", "f-favorite-number"),
        buildTextField("your method number", "f-their-number")
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
    // HEIC is listed so iPhones hand over the original rather than Safari's
    // auto-converted JPEG — the original still carries its GPS. shrinkImage
    // re-encodes everything to JPEG before upload, so nothing HEIC-shaped
    // reaches the bucket (no other browser could display it).
    const IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

    // Chrome on Android sends a media-only `accept` through the system photo
    // picker, and that picker hands back a copy with the GPS tags removed —
    // which is why phone uploads stopped carrying a location while the same
    // file read fine on a desktop. Leaving `accept` open puts the ordinary
    // file chooser back, which reads the file as it is stored.
    //
    // Only Android: on iOS the media list is what makes the picker open
    // straight into the photo library, and on desktop it usefully filters.
    input.accept = /Android/i.test(navigator.userAgent) ? "" : IMAGE_TYPES;
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
    helper.textContent = "JPEG, PNG, WebP or HEIC · published immediately";
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
    // Photo pickers often report an empty type for HEIC, so fall back to the
    // extension rather than silently dropping the file.
    const files = [...fileList].filter((f) => f.type.startsWith("image/") || looksHeic(f));
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
        // shrinkImage hands the original back when it couldn't decode it. For
        // HEIC that means this browser has no decoder (Chrome, Firefox, Edge
        // — only Safari does), and uploading it raw would store a picture
        // almost nobody could see. Say so plainly instead.
        if (blob === file && looksHeic(file)) {
          throw new Error(
            "this browser can't read HEIC photos — open the site in Safari, or set the camera to \"Most Compatible\""
          );
        }
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
  function looksHeic(file) {
    return /^image\/hei[cf]$/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
  }

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
    // Registered here, before the listeners further down, so they only ever
    // see an already-filtered value.
    restrictToDigits(numberInput, { list: true });
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
