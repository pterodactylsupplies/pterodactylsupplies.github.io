(() => {
  const API = window.CONFIG.API_BASE.replace(/\/$/, "");
  const app = document.getElementById("app");
  const progressEl = document.getElementById("progress");

  // key -> photo lists, fetched from the worker
  let photosByNumber = {};

  const imgUrl = (key) => `${API}/img/${key}`;

  async function loadPhotos() {
    const res = await fetch(`${API}/api/photos`);
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    photosByNumber = await res.json();
  }

  function currentNumber() {
    const m = location.hash.match(/^#\/?(\d{1,3})$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 100 ? n : null;
  }

  function render() {
    const n = currentNumber();
    if (n) renderDetail(n);
    else renderGrid();
    window.scrollTo(0, 0);
  }

  function renderProgress() {
    const collected = Object.keys(photosByNumber).filter(
      (k) => (photosByNumber[k] || []).length > 0
    ).length;
    const total = Object.values(photosByNumber).reduce(
      (sum, list) => sum + list.length, 0
    );
    progressEl.innerHTML =
      `<strong>${collected}</strong> of 100 numbers collected · ${total} photo${total === 1 ? "" : "s"}`;
  }

  function renderGrid() {
    const grid = document.createElement("div");
    grid.className = "number-grid";
    for (let i = 1; i <= 100; i++) {
      const photos = photosByNumber[i] || [];
      const cell = document.createElement("a");
      cell.href = `#/${i}`;
      cell.className = `cell ${photos.length ? "filled" : "empty"}`;
      cell.setAttribute("aria-label", `Number ${i}, ${photos.length} photos`);

      const num = document.createElement("span");
      num.className = "cell-number";
      num.textContent = i;

      if (photos.length) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = `Photo of the number ${i}`;
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
    app.replaceChildren(grid);
    renderProgress();
  }

  function renderDetail(n) {
    const photos = photosByNumber[n] || [];
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
      <p class="dateline">${photos.length} photo${photos.length === 1 ? "" : "s"} on file</p>
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
        img.alt = `Photo of the number ${n}`;
        img.src = imgUrl(p.key);
        link.appendChild(img);
        fig.appendChild(link);
        const cap = document.createElement("figcaption");
        cap.className = "tiny caption";
        cap.textContent = `Plate ${i + 1} of ${photos.length}`;
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

  function buildUploadBox(n) {
    const box = document.createElement("div");
    box.className = "upload-box";
    box.innerHTML = `
      <p class="kicker">Submit a plate</p>
      <h3>Add a photo of ${n}</h3>
      <p class="tiny">JPEG, PNG or WebP &middot; published immediately</p>
      <label class="upload-btn">Choose photo(s)
        <input type="file" accept="image/*" multiple>
      </label>
      <div class="upload-status" role="status"></div>`;

    const input = box.querySelector("input");
    const status = box.querySelector(".upload-status");

    input.addEventListener("change", () => handleFiles(input.files, n, status));

    box.addEventListener("dragover", (e) => {
      e.preventDefault();
      box.classList.add("dragover");
    });
    box.addEventListener("dragleave", () => box.classList.remove("dragover"));
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("dragover");
      handleFiles(e.dataTransfer.files, n, status);
    });
    return box;
  }

  async function handleFiles(fileList, n, status) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      setStatus(status, "err", "That doesn't look like an image.");
      return;
    }
    let done = 0;
    for (const file of files) {
      setStatus(status, "", `Uploading ${done + 1} of ${files.length}…`);
      try {
        const blob = await shrinkImage(file);
        const form = new FormData();
        form.append("number", String(n));
        form.append("photo", blob, "photo.jpg");
        const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `upload failed (${res.status})`);
        done++;
      } catch (err) {
        setStatus(status, "err", `Upload failed: ${err.message}`);
        return;
      }
    }
    await loadPhotos();
    render();
    // render() rebuilt the page, so put the confirmation on the new status element
    const freshStatus = app.querySelector(".upload-status");
    if (freshStatus) {
      setStatus(freshStatus, "ok", done === 1 ? "Photo added!" : `${done} photos added!`);
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

  // ---- boot ----
  window.addEventListener("hashchange", render);
  document.getElementById("home-link").addEventListener("click", () => {
    location.hash = "";
  });

  loadPhotos()
    .then(render)
    .catch((err) => {
      app.innerHTML = `<p class="error">Couldn't reach the photo API (${err.message}).<br>Check API_BASE in config.js.</p>`;
    });
})();
