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

  // "7, 42, 7" -> [7, 42] — parses a free-text number list, dedupes, drops junk.
  // A single picture can be tagged with more than one number (it might show
  // several), so every number-entry field in this file accepts a list.
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
  // Remembers (name + size) of pictures already uploaded this browser
  // session, so re-selecting the same file doesn't silently create a
  // second copy. Not persisted across tabs/restarts on purpose — it's a
  // "did you mean to do that again?" nudge, not a hard block.
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

  async function loadPhotos() {
    const res = await fetch(`${API}/api/photos`);
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    photosByNumber = await res.json();
  }

  // Numbers 1-100 get their own grid cell; anything else (0, negatives,
  // 101+) is grouped under the "OTHERS" bucket.
  function currentNumber() {
    const m = location.hash.match(/^#\/?(-?\d{1,6})$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 100 ? n : null;
  }

  function othersEntries() {
    const seen = new Set();
    const entries = [];
    for (const [k, list] of Object.entries(photosByNumber)) {
      const n = parseInt(k, 10);
      if (n >= 1 && n <= 100) continue;
      for (const p of list) {
        // the same picture can be tagged under more than one out-of-range
        // number — list it once, not once per tag.
        if (seen.has(p.key)) continue;
        seen.add(p.key);
        entries.push(p);
      }
    }
    entries.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));
    return entries;
  }

  function render() {
    if (location.hash === "#/others") {
      renderOthers();
    } else {
      const n = currentNumber();
      if (n) renderDetail(n);
      else renderGrid();
    }
    window.scrollTo(0, 0);
  }

  function renderProgress() {
    const collected = Object.entries(photosByNumber).filter(([k, list]) => {
      const n = parseInt(k, 10);
      return n >= 1 && n <= 100 && list.length > 0;
    }).length;
    // count unique pictures, not tag count — a picture tagged under two
    // numbers is still one picture.
    const uniqueKeys = new Set();
    for (const list of Object.values(photosByNumber)) {
      for (const p of list) uniqueKeys.add(p.key);
    }
    const total = uniqueKeys.size;
    progressEl.innerHTML =
      `<strong>${collected}</strong> of 100 numbers collected · ${total} picture${total === 1 ? "" : "s"}`;
  }

  function renderGrid() {
    const grid = document.createElement("div");
    grid.className = "number-grid";
    for (let i = 1; i <= 100; i++) {
      const photos = photosByNumber[i] || [];
      const cell = document.createElement("a");
      cell.href = `#/${i}`;
      cell.className = `cell ${photos.length ? "filled" : "empty"}`;
      cell.setAttribute("aria-label", `Number ${i}, ${photos.length} pictures`);

      const num = document.createElement("span");
      num.className = "cell-number";
      num.textContent = i;

      if (photos.length) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = `Picture of the number ${i}`;
        img.src = imgUrl(photos[photos.length - 1].key);
        cell.appendChild(img);
        if (photos.length > 1) {
          const count = document.createElement("span");
          count.className = "cell-count";
          count.textContent = photos.length;
          cell.appendChild(count);
        }
      }
      cell.appendChild(num);
      grid.appendChild(cell);
    }

    const others = othersEntries();
    const othersCell = document.createElement("a");
    othersCell.href = "#/others";
    othersCell.className = `cell others ${others.length ? "filled" : "empty"}`;
    othersCell.setAttribute("aria-label", `Others, ${others.length} pictures`);
    if (others.length) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "A picture from the Others bucket";
      img.src = imgUrl(others[others.length - 1].key);
      othersCell.appendChild(img);
      if (others.length > 1) {
        const count = document.createElement("span");
        count.className = "cell-count";
        count.textContent = others.length;
        othersCell.appendChild(count);
      }
    }
    const othersLabel = document.createElement("span");
    othersLabel.className = "cell-number";
    othersLabel.textContent = "OTHERS";
    othersCell.appendChild(othersLabel);
    grid.appendChild(othersCell);

    app.replaceChildren(grid);
    renderProgress();
  }

  function renderOthers() {
    const entries = othersEntries();
    const mine = loadMyUploads();
    const frag = document.createDocumentFragment();

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← All numbers";
    frag.appendChild(back);

    const header = document.createElement("div");
    header.className = "detail-header";
    header.innerHTML = `
      <p class="kicker">Others</p>
      <h2 class="detail-number">&infin;</h2>
      <p class="dateline">${entries.length} picture${entries.length === 1 ? "" : "s"} on file</p>`;
    frag.appendChild(header);

    const divider = document.createElement("div");
    divider.className = "rule-double";
    frag.appendChild(divider);

    if (entries.length) {
      const grid = document.createElement("div");
      grid.className = "photo-grid";
      entries.forEach((p) => {
        const fig = document.createElement("figure");
        const link = document.createElement("a");
        link.href = imgUrl(p.key);
        link.target = "_blank";
        link.rel = "noopener";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = `Picture marked ${p.numbers.join(", ")}`;
        img.src = imgUrl(p.key);
        link.appendChild(img);
        fig.appendChild(link);

        const cap = document.createElement("figcaption");

        if (p.caption) {
          const title = document.createElement("span");
          title.className = "entry-title";
          title.textContent = p.caption;
          cap.appendChild(title);
        }

        const meta = document.createElement("span");
        meta.className = "tiny caption";
        const metaBits = [`marked ${p.numbers.join(", ")}`];
        if (p.submitter) metaBits.push(`by ${p.submitter}`);
        meta.textContent = metaBits.join(" · ");
        cap.appendChild(meta);

        if (mine[p.key]) {
          const undo = document.createElement("a");
          undo.href = "#";
          undo.className = "tiny undo-link";
          undo.textContent = "[remove]";
          undo.addEventListener("click", (e) => {
            e.preventDefault();
            if (confirm("Remove this picture? This can't be undone.")) {
              undoUpload(p.key, undo);
            }
          });
          cap.appendChild(undo);
        }

        fig.appendChild(cap);
        grid.appendChild(fig);
      });
      frag.appendChild(grid);
    } else {
      const empty = document.createElement("p");
      empty.className = "no-photos";
      empty.textContent = "Nothing here yet — numbers that don't fit 1–100 land in this bucket.";
      frag.appendChild(empty);
    }

    const hint = document.createElement("p");
    hint.className = "tiny others-hint";
    hint.textContent = "Use “+ add a number” above to add something here.";
    frag.appendChild(hint);

    app.replaceChildren(frag);
    renderProgress();
  }

  function renderDetail(n) {
    const photos = photosByNumber[n] || [];
    const mine = loadMyUploads();
    const frag = document.createDocumentFragment();

    const back = document.createElement("a");
    back.className = "back-link";
    back.href = "#";
    back.textContent = "← All numbers";
    frag.appendChild(back);

    const header = document.createElement("div");
    header.className = "detail-header";
    header.innerHTML = `
      <p class="kicker">No. ${String(n).padStart(3, "0")}</p>
      <h2 class="detail-number">${n}</h2>
      <p class="dateline">${photos.length} picture${photos.length === 1 ? "" : "s"} on file</p>
      <nav class="detail-nav">
        ${n > 1 ? `<a href="#/${n - 1}">&larr; ${n - 1}</a>` : ""}
        ${n < 100 ? `<a href="#/${n + 1}">${n + 1} &rarr;</a>` : ""}
      </nav>`;
    frag.appendChild(header);

    const divider = document.createElement("div");
    divider.className = "rule-double";
    frag.appendChild(divider);

    if (photos.length) {
      const grid = document.createElement("div");
      grid.className = "photo-grid";
      photos.forEach((p, i) => {
        const fig = document.createElement("figure");
        const link = document.createElement("a");
        link.href = imgUrl(p.key);
        link.target = "_blank";
        link.rel = "noopener";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = `Picture of the number ${n}`;
        img.src = imgUrl(p.key);
        link.appendChild(img);
        fig.appendChild(link);

        const cap = document.createElement("figcaption");

        if (p.caption) {
          const title = document.createElement("span");
          title.className = "entry-title";
          title.textContent = p.caption;
          cap.appendChild(title);
        }

        const meta = document.createElement("span");
        meta.className = "tiny caption";
        const metaBits = [];
        if (p.submitter) metaBits.push(`by ${p.submitter}`);
        const alsoOn = (p.numbers || []).filter((x) => x !== n);
        if (alsoOn.length) metaBits.push(`also on ${alsoOn.join(", ")}`);
        metaBits.push(`Plate ${i + 1} of ${photos.length}`);
        meta.textContent = metaBits.join(" · ");
        cap.appendChild(meta);

        if (mine[p.key]) {
          const undo = document.createElement("a");
          undo.href = "#";
          undo.className = "tiny undo-link";
          undo.textContent = "[remove]";
          undo.addEventListener("click", (e) => {
            e.preventDefault();
            if (confirm("Remove this picture? This can't be undone.")) {
              undoUpload(p.key, undo);
            }
          });
          cap.appendChild(undo);
        }

        fig.appendChild(cap);
        grid.appendChild(fig);
      });
      frag.appendChild(grid);
    } else {
      const empty = document.createElement("p");
      empty.className = "no-photos";
      empty.textContent = `Nobody has spotted a ${n} yet — be the first!`;
      frag.appendChild(empty);
    }

    frag.appendChild(buildUploadBox(n));
    app.replaceChildren(frag);
    renderProgress();
  }

  // ---- shared upload form fields (name/caption inputs), used by both the
  // inline per-number box and the global "add any number" modal.
  function buildMetaFields() {
    const wrap = document.createElement("div");
    wrap.className = "upload-fields";
    wrap.innerHTML = `
      <input type="text" class="f-caption" placeholder="what is it" maxlength="80">
      <input type="text" class="f-submitter" placeholder="your name" maxlength="80">`;
    return wrap;
  }

  function buildUploadBox(n) {
    const box = document.createElement("div");
    box.className = "upload-box";
    box.innerHTML = `
      <p class="kicker">Submit a plate</p>
      <h3>Add a picture of ${n}</h3>
      <p class="tiny">JPEG, PNG or WebP &middot; published immediately</p>`;

    box.appendChild(buildMetaFields());

    const alsoField = document.createElement("div");
    alsoField.className = "also-numbers-field";
    alsoField.innerHTML = `
      <input type="text" class="f-also-numbers" placeholder="also shows (comma-separated, optional)" maxlength="80">`;
    box.appendChild(alsoField);

    const btnRow = document.createElement("div");
    btnRow.innerHTML = `
      <label class="upload-btn">Choose picture(s)
        <input type="file" accept="image/*" multiple>
      </label>
      <div class="upload-status" role="status"></div>`;
    box.appendChild(btnRow);

    const input = box.querySelector("input[type=file]");
    const status = box.querySelector(".upload-status");

    const meta = () => ({
      submitter: box.querySelector(".f-submitter").value,
      caption: box.querySelector(".f-caption").value,
    });

    // this box always tags the page's own number, plus whatever extra
    // numbers the contributor lists (e.g. the same picture also shows 42).
    const numbers = () => {
      const extra = parseNumberList(box.querySelector(".f-also-numbers").value);
      return parseNumberList([n, ...extra].join(","));
    };

    input.addEventListener("change", () => submitPhotos(input.files, numbers(), meta(), status));

    box.addEventListener("dragover", (e) => {
      e.preventDefault();
      box.classList.add("dragover");
    });
    box.addEventListener("dragleave", () => box.classList.remove("dragover"));
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("dragover");
      submitPhotos(e.dataTransfer.files, numbers(), meta(), status);
    });
    return box;
  }

  // Core upload routine, shared by the inline box and the global modal.
  // `numbers` is the list of numbers this batch of pictures should be
  // tagged with (at least one). On success, reloads data and re-renders.
  async function submitPhotos(fileList, numbers, meta, status) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      setStatus(status, "err", "That doesn't look like an image.");
      return;
    }
    if (!numbers || !numbers.length) {
      setStatus(status, "err", "Enter at least one number first.");
      return;
    }

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
        if (meta.submitter) form.append("submitter", meta.submitter);
        if (meta.caption) form.append("caption", meta.caption);
        const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `upload failed (${res.status})`);
        rememberUpload(body.key, body.deleteToken);
        recentSigs.add(sig);
        saveRecentSignatures(recentSigs);
        done++;
      } catch (err) {
        setStatus(status, "err", `Upload failed: ${err.message}`);
        return;
      }
    }

    if (!done) {
      setStatus(status, "", "Nothing uploaded.");
      return;
    }

    await loadPhotos();
    const currentN = currentNumber();
    const onOthers = location.hash === "#/others";
    const alreadyThere =
      (currentN !== null && numbers.includes(currentN)) ||
      (onOthers && numbers.some((x) => !(x >= 1 && x <= 100)));

    if (alreadyThere) {
      render();
      const freshStatus = app.querySelector(".upload-status");
      if (freshStatus) {
        const onLabel = numbers.length === 1 ? `on ${numbers[0]}` : `on ${numbers.join(", ")}`;
        setStatus(freshStatus, "ok", (done === 1 ? "Picture added " : `${done} pictures added `) + onLabel + "! You can remove it anytime from below.");
      }
    } else {
      const inRangeNumbers = numbers.filter((x) => x >= 1 && x <= 100);
      location.hash = inRangeNumbers.length ? `#/${inRangeNumbers[0]}` : "#/others";
    }
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

  // ---- global "add any number" modal ----
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

    dialog.innerHTML = `
      <a href="#" class="modal-close tiny">[x] close</a>
      <p class="kicker" id="modal-title">add a number</p>
      <label class="modal-label tiny" for="modal-number">your number</label>
      <input type="text" id="modal-number" required placeholder="e.g. 7 or 7, 42">
      <p class="tiny modal-number-hint">shows more than one number? separate with commas</p>`;

    const fields = buildMetaFields();
    dialog.appendChild(fields);

    const btnRow = document.createElement("div");
    btnRow.innerHTML = `
      <label class="upload-btn">Choose picture(s)
        <input type="file" accept="image/*" multiple disabled>
      </label>
      <div class="upload-status" role="status"></div>`;
    dialog.appendChild(btnRow);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const numberInput = dialog.querySelector("#modal-number");
    const fileInput = dialog.querySelector("input[type=file]");
    const status = dialog.querySelector(".upload-status");
    const closeLink = dialog.querySelector(".modal-close");

    function syncFileEnabled() {
      fileInput.disabled = parseNumberList(numberInput.value).length === 0;
    }
    numberInput.addEventListener("input", syncFileEnabled);

    const meta = () => ({
      submitter: dialog.querySelector(".f-submitter").value,
      caption: dialog.querySelector(".f-caption").value,
    });

    fileInput.addEventListener("change", () => {
      const numbers = parseNumberList(numberInput.value);
      if (!numbers.length) {
        setStatus(status, "err", "Enter at least one number first.");
        return;
      }
      submitPhotos(fileInput.files, numbers, meta(), status).then(closeModal);
    });

    function openModal() {
      numberInput.value = currentNumber() || "";
      dialog.querySelector(".f-submitter").value = "";
      dialog.querySelector(".f-caption").value = "";
      status.textContent = "";
      status.className = "upload-status";
      syncFileEnabled();
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
