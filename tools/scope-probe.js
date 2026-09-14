/*
 * Drive Dupe Destroyer (DDD) — tools/scope-probe.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Logic for tools/scope-probe.html. Kept external rather than inline because
// the app's CSP sets script-src without 'unsafe-inline' — an inline block here
// would be silently blocked, and the probe would look broken for reasons that
// have nothing to do with what it is testing.

const SCOPE = "https://www.googleapis.com/auth/drive.file";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
let lines = [];

function log(msg, cls = "") {
  lines.push(cls ? `<span class="${cls}">${msg}</span>` : msg);
  logEl.innerHTML = lines.join("\n");
  logEl.classList.remove("muted");
  logEl.scrollTop = logEl.scrollHeight;
}

// --- library readiness -------------------------------------------------------
let gisReady = false, pickerReady = false;

function maybeEnable() {
  if (gisReady && pickerReady) {
    $("run").disabled = false;
    $("run").textContent = "Run the probe";
  }
}

const poll = setInterval(() => {
  if (!gisReady && window.google?.accounts?.oauth2) { gisReady = true; maybeEnable(); }
  if (!pickerReady && window.gapi) {
    gapi.load("picker", () => { pickerReady = true; maybeEnable(); });
  }
  if (gisReady && pickerReady) clearInterval(poll);
}, 150);

setTimeout(() => {
  if (!gisReady || !pickerReady) {
    $("run").textContent = "Google libraries failed to load";
    log("Could not load accounts.google.com/gsi/client or apis.google.com/js/api.js.", "bad");
    log("Check the network tab — an ad blocker or a strict CSP will do this.", "muted");
  }
}, 10000);

// --- Drive helpers -----------------------------------------------------------
async function driveCall(token, path, params = {}) {
  const url = new URL("https://www.googleapis.com/drive/v3/" + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function describeFailure(status, body) {
  const reason = body?.error?.message || "(no message)";
  return `HTTP ${status} — ${reason}`;
}

// --- the probe ---------------------------------------------------------------
async function probe(token, folder) {
  const results = {};
  log(`\nPicked folder: ${folder.name}`, "ok");
  log(`  id: ${folder.id}`, "muted");

  // 1. the folder object itself
  log("\n[1/4] files.get on the picked folder…");
  const meta = await driveCall(token, `files/${folder.id}`, { fields: "id,name,mimeType" });
  results.folderReadable = meta.ok;
  log(meta.ok ? `  OK — ${meta.body.name} (${meta.body.mimeType})` : `  FAILED — ${describeFailure(meta.status, meta.body)}`,
      meta.ok ? "ok" : "bad");

  // 2. direct children
  log("\n[2/4] files.list — direct children of the picked folder…");
  const kids = await driveCall(token, "files", {
    q: `'${folder.id}' in parents and trashed = false`,
    fields: "files(id,name,mimeType)",
    pageSize: "100",
  });
  // A 200 with zero rows is NOT proof of access.
  //
  // Google's own discovery document (revision 20260904) lists drive.file among
  // the scopes files.list accepts, and describes it as "only the SPECIFIC
  // Google Drive files you use with this app". So the call is permitted and
  // returns the intersection of the query with the app's granted set: a folder
  // whose children were never granted yields HTTP 200 and an empty list, not an
  // error. Treating ok as access made this probe report "drive.file is
  // sufficient" for exactly the case that proves it is not -- the wrong answer,
  // and the expensive one to act on.
  results.childrenListable = kids.ok && (kids.body.files || []).length > 0;
  results.childrenPermitted = kids.ok;
  results.childCount = kids.ok ? (kids.body.files || []).length : 0;
  if (kids.ok) {
    log(`  ${results.childCount ? "OK" : "PERMITTED BUT EMPTY"} — ${results.childCount} item(s) visible`,
        results.childCount ? "ok" : "bad");
    if (!results.childCount) {
      log("  An empty list here is the signature of per-file access: the call is", "muted");
      log("  allowed, but nothing inside the folder was ever granted to this app.", "muted");
    }
    for (const f of (kids.body.files || []).slice(0, 5)) log(`    · ${f.name} — ${f.mimeType}`, "muted");
    if (results.childCount > 5) log(`    · …and ${results.childCount - 5} more`, "muted");
  } else {
    log(`  FAILED — ${describeFailure(kids.status, kids.body)}`, "bad");
  }

  // 3. images specifically — what a scan actually needs
  log("\n[3/4] files.list — images inside the picked folder…");
  const imgs = await driveCall(token, "files", {
    q: `'${folder.id}' in parents and trashed = false and mimeType contains 'image/'`,
    fields: "files(id,name,md5Checksum,thumbnailLink)",
    pageSize: "100",
  });
  results.imagesListable = imgs.ok && (imgs.body.files || []).length > 0;
  results.imagesPermitted = imgs.ok;
  results.imageCount = imgs.ok ? (imgs.body.files || []).length : 0;
  if (imgs.ok) {
    const withMd5 = (imgs.body.files || []).filter(f => f.md5Checksum).length;
    log(`  OK — ${results.imageCount} image(s); ${withMd5} expose md5Checksum`, results.imageCount ? "ok" : "warn");
    results.md5Visible = withMd5 > 0;
  } else {
    log(`  FAILED — ${describeFailure(imgs.status, imgs.body)}`, "bad");
  }

  // 4. THE decisive one — does the grant recurse into a subfolder?
  log("\n[4/4] files.list — one level DEEPER, inside a subfolder…");
  const subfolder = (kids.body.files || []).find(f => f.mimeType === "application/vnd.google-apps.folder");
  if (!subfolder) {
    results.recursion = "untested";
    log("  SKIPPED — the picked folder has no subfolder.", "warn");
    log("  Re-run and choose a folder that contains one; this is the check that matters.", "warn");
  } else {
    log(`  Descending into: ${subfolder.name}`, "muted");
    const deep = await driveCall(token, "files", {
      q: `'${subfolder.id}' in parents and trashed = false`,
      fields: "files(id,name,mimeType)",
      pageSize: "100",
    });
    results.deepCount = deep.ok ? (deep.body.files || []).length : 0;
    results.recursion = !deep.ok ? "no" : (results.deepCount > 0 ? "yes" : "empty");
    log(!deep.ok ? `  FAILED — ${describeFailure(deep.status, deep.body)}`
        : results.deepCount ? `  OK — ${results.deepCount} item(s) visible inside the subfolder`
        : "  PERMITTED BUT EMPTY — the call succeeded and returned nothing",
        results.deepCount ? "ok" : "bad");
  }

  render(results);
}

function render(r) {
  const el = $("verdict");
  const canScanFlat = r.childrenListable && r.imagesListable;
  const canScanDeep = r.recursion === "yes";

  // "Permitted but empty" is its own outcome and the most likely one. The call
  // is allowed under drive.file -- Google's discovery document lists it among
  // the scopes files.list accepts -- but it returns only files the app was
  // granted, so a folder whose children were never picked yields 200 and
  // nothing. An earlier version of this page counted that as success and would
  // have reported the scope sufficient when it is not.
  const permittedButEmpty = r.childrenPermitted && !r.childrenListable;

  if (canScanFlat && canScanDeep) {
    el.className = "verdict yes";
    el.innerHTML =
      "<strong>drive.file is sufficient.</strong><br>" +
      "A picked folder's contents AND its subfolders are readable with the non-sensitive scope — " +
      `${r.childCount} child item(s) and ${r.deepCount} inside a subfolder, none of which this app ` +
      "was ever granted individually. DDD can drop the restricted <code>auth/drive</code> scope for " +
      "scanning — no OAuth verification, no CASA assessment, no bring-your-own-Client-ID. Trashing " +
      "still needs checking separately (this probe is read-only), but the hard part is answered: " +
      "<strong>close #28 as viable.</strong>";
  } else if (permittedButEmpty) {
    el.className = "verdict no";
    el.innerHTML =
      "<strong>drive.file grants the folder, not its contents.</strong><br>" +
      "Listing the picked folder's children was <em>allowed</em> and returned <strong>nothing</strong>. " +
      "That is per-file access behaving exactly as documented: the folder you picked was granted, " +
      "the files inside it were not, and a query for them is answered with an empty list rather " +
      "than an error.<br><br>" +
      "<strong>Check the folder actually has files in it</strong> — if it is genuinely empty this " +
      "result means nothing, so re-run on a folder with images. Otherwise the restricted scope is " +
      "load-bearing: <strong>close #28 as won't-fix</strong> and keep the bring-your-own-Client-ID model.";
  } else if (canScanFlat && r.recursion === "no") {
    el.className = "verdict no";
    el.innerHTML =
      "<strong>drive.file is not sufficient for recursive scanning.</strong><br>" +
      "The picked folder's direct children are readable, but listing inside a subfolder was refused. " +
      "Since DDD scans recursively, the restricted scope stays load-bearing — unless the UX changes " +
      "to make the user pick every folder individually. " +
      "<strong>Record this on #28 and close it as won't-fix.</strong>";
  } else if (canScanFlat && r.recursion === "empty") {
    el.className = "verdict no";
    el.innerHTML =
      "<strong>The grant does not reach into subfolders.</strong><br>" +
      "The picked folder's own children are readable, but the same query one level deeper was " +
      "allowed and returned <strong>nothing</strong> — the subfolder's contents were never granted. " +
      "Confirm that subfolder is not simply empty; if it has files, DDD's recursive scan cannot run " +
      "on this scope. <strong>Close #28 as won't-fix.</strong>";
  } else if (canScanFlat && r.recursion === "untested") {
    el.className = "verdict no";
    el.innerHTML =
      "<strong>Inconclusive — re-run.</strong><br>" +
      "Flat listing works, but the picked folder had no subfolder so recursion was never tested. " +
      "That is the check that decides #28. Pick a folder containing a subfolder and run again.";
  } else {
    el.className = "verdict no";
    el.innerHTML =
      "<strong>drive.file cannot enumerate a picked folder.</strong><br>" +
      "Listing the folder's contents failed outright, so the scope cannot back the scan at all. " +
      "The restricted scope is required. <strong>Close #28 as won't-fix</strong>, and keep the " +
      "bring-your-own-Client-ID model.";
  }

  log("\n--- raw results ---", "muted");
  log(JSON.stringify(r, null, 2), "muted");
}

// --- wire up -----------------------------------------------------------------
$("run").onclick = () => {
  const clientId = $("clientId").value.trim();
  const apiKey = $("apiKey").value.trim();

  if (!clientId.endsWith(".apps.googleusercontent.com")) {
    log("That does not look like an OAuth Client ID.", "bad");
    return;
  }
  if (!apiKey) {
    log("An API key is required — the Picker will not load without one.", "bad");
    return;
  }

  lines = [];
  $("verdict").className = "";
  $("verdict").innerHTML = "";
  log(`Requesting ONLY: ${SCOPE}`, "warn");
  log("(the restricted auth/drive scope is deliberately not requested)", "muted");

  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (resp) => {
      if (!resp?.access_token) {
        log(`\nToken request failed: ${resp?.error || "unknown"}`, "bad");
        return;
      }
      log("\nToken granted. Opening the Picker — choose a folder…", "ok");

      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes("application/vnd.google-apps.folder");

      new google.picker.PickerBuilder()
        .setOAuthToken(resp.access_token)
        .setDeveloperKey(apiKey)
        .addView(view)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            probe(resp.access_token, { id: doc.id, name: doc.name })
              .catch(e => log(`\nProbe threw: ${e.message}`, "bad"));
          } else if (data.action === google.picker.Action.CANCEL) {
            log("\nPicker cancelled — nothing tested.", "warn");
          }
        })
        .build()
        .setVisible(true);
    },
  });

  tokenClient.requestAccessToken({ prompt: "consent" });
};
