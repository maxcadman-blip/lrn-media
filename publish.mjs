#!/usr/bin/env node
/*
 * lrn.to social publisher — Instagram + Facebook Page
 * ---------------------------------------------------------------------------
 * Publishes one queued clip per run to both platforms. Driven by GitHub Actions
 * on a daily cron; runs identically on a laptop.
 *
 * Credentials come from the environment and are never logged, written to disk,
 * or included in an error message — see redact(). Both are optional: whichever
 * is set gets posted to, so Facebook could be added later without touching
 * Instagram, and a revoked token degrades to one platform instead of none.
 *
 *   IG_TOKEN        Instagram, from the app's Instagram Login "Customize" page
 *   FB_PAGE_TOKEN   Facebook Page, from /me/accounts with a long-lived user token
 *
 *   node publish.mjs            publish anything due today or overdue
 *   node publish.mjs --dry-run  everything except the final publish call
 *   node publish.mjs --check    verify tokens, accounts and video URLs; post nothing
 *
 * Two different APIs, for a reason. Instagram is on the Instagram Login path
 * (graph.instagram.com, instagram_business_* permissions); Facebook is on the
 * Graph API (graph.facebook.com, pages_* permissions). They could have been
 * unified under Facebook Login, but that would have meant rebuilding a working
 * Instagram integration, and the separate Page token has the better property:
 * Page tokens derived from a long-lived user token do not expire by time.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const IG_API = "https://graph.instagram.com/v23.0";
const FB_API = "https://graph.facebook.com/v25.0";

const IG_TOKEN = process.env.IG_TOKEN || "";
const FB_TOKEN = process.env.FB_PAGE_TOKEN || "";
const DRY = process.argv.includes("--dry-run");
const CHECK = process.argv.includes("--check");

const QUEUE = join(HERE, "queue.json");
const LEDGER = join(HERE, "posted.json");

/* Every string that leaves this process passes through here. Tokens have a habit
   of reaching CI logs via error objects that quote the request URL. */
const SECRETS = [IG_TOKEN, FB_TOKEN].filter(s => s.length > 8);
const redact = s => {
  let out = String(s);
  for (const t of SECRETS) out = out.replaceAll(t, "[REDACTED]");
  return out.replace(/((?:access_token|file_url)=)[^&\s"]+/g, "$1[REDACTED]")
            .replace(/(OAuth )\S+/g, "$1[REDACTED]");
};

const log = (...a) => console.log(...a.map(redact));
const die = msg => { console.error("\n✗ " + redact(msg) + "\n"); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const readJson = (p, fb) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fb;

/* ------------------------------------------------------------------ requests */

async function call(base, path, { method = "GET", params = {}, token } = {}) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === "GET"
    ? await fetch(`${base}${path}?${body}`)
    : await fetch(base + path, { method, body });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${method} ${path} returned non-JSON (HTTP ${res.status}):\n${text.slice(0, 300)}`); }

  if (json.error) {
    const e = json.error;
    throw new Error(
      `${method} ${path}\n  ${e.type ?? "Error"} ${e.code ?? ""}` +
      `${e.error_subcode ? "/" + e.error_subcode : ""}: ${e.message}` +
      (e.error_user_msg ? `\n  ${e.error_user_msg}` : "") + explain(e)
    );
  }
  return json;
}

/* Meta's errors are terse, and the useful part is what they imply rather than
   what they say. These are the ones that actually happen. */
function explain(e) {
  const m = (e.message || "").toLowerCase();
  if (e.code === 190) return "\n  → Token expired or revoked. Generate a new one and update the repo secret.";
  if (e.code === 200 || m.includes("permission"))
    return "\n  → Missing a publishing permission, or the Instagram Tester invite was never accepted.";
  if (m.includes("download") || m.includes("fetch"))
    return "\n  → Meta couldn't fetch the video URL. It must return HTTP 200 and Content-Type video/mp4,\n" +
           "    and allow the facebookexternalhit/1.1 user agent. Raw githubusercontent URLs fail here.";
  return "";
}

/* Checked before a container is created anywhere: a post built against a URL
   Meta can't read fails minutes later with a message that never mentions it. */
async function checkVideo(url) {
  const res = await fetch(url, { method: "HEAD", headers: { "user-agent": "facebookexternalhit/1.1" } });
  const type = res.headers.get("content-type") || "";
  const size = Number(res.headers.get("content-length") || 0);
  return { ok: res.ok && type.startsWith("video/"), status: res.status, type: type || "(none)", mb: (size / 1048576).toFixed(2) };
}

/* --------------------------------------------------------------- instagram */

const igMe = () => call(IG_API, "/me", { params: { fields: "user_id,username" }, token: IG_TOKEN });

/* Container, then poll, then publish. The poll is the step people skip, and it
   is why posts appear to vanish — publishing a container that isn't FINISHED
   fails, and the error doesn't say why. */
async function igPublish(igId, videoUrl, caption) {
  const { id: creationId } = await call(IG_API, `/${igId}/media`, {
    method: "POST", token: IG_TOKEN,
    params: { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true" },
  });
  log(`    container ${creationId}`);

  const deadline = Date.now() + 6 * 60_000;
  let wait = 5_000;
  for (;;) {
    await sleep(wait);
    const { status_code, status } = await call(IG_API, `/${creationId}`, { params: { fields: "status_code,status" }, token: IG_TOKEN });
    if (status_code === "FINISHED") { log(`    transcoded`); break; }
    if (status_code === "ERROR") throw new Error(`Instagram rejected the video: ${status ?? "no detail"}`);
    if (Date.now() > deadline) throw new Error(`Container stuck on ${status_code} after 6 minutes. Not publishing.`);
    log(`    ${status_code}…`);
    wait = Math.min(wait * 1.5, 30_000);
  }

  if (DRY) { log(`    --dry-run: stopping before publish`); return null; }
  const { id } = await call(IG_API, `/${igId}/media_publish`, { method: "POST", token: IG_TOKEN, params: { creation_id: creationId } });
  return id;
}

/* ---------------------------------------------------------------- facebook */

/* Two kinds of credential end up here and they answer "who am I?" differently.
   A Page access token's /me IS the Page. A system user token's /me is the system
   user — the Pages it can act for come from /me/accounts, which also hands back a
   per-Page token to publish with. Resolve both, and fall back to the Page id in
   queue.json so a business-owned Page that lists oddly still works. */
async function fbResolve(configuredId) {
  /* Every branch below now says out loud why it was taken. On 8 Sep this lookup
     came back empty, the code fell through silently to posting as the system user,
     and Facebook answered "Object with ID '1233370956533582' does not exist" — an
     error about the Page that was really an error about the token. Two days of the
     wrong diagnosis for want of one printed line. */
  /* Retried, because one empty response is not evidence the Page is gone. On 8 Sep
     this came back empty and cost a day's Facebook post; a check run the next
     morning, same token and same Page, listed it immediately. Three tries with a
     widening gap turns that class of blip into a pause instead of a missed day. */
  let reason = null, pages = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const accounts = await call(FB_API, "/me/accounts", { params: { fields: "id,name,access_token" }, token: FB_TOKEN })
      .catch(e => { reason = e.message.split("\n")[0]; return { data: [] }; });
    pages = accounts.data ?? [];
    if (pages.length) break;
    if (attempt < 3) {
      log(`  /me/accounts listed no Pages (try ${attempt} of 3) — waiting ${attempt * 5}s`);
      await sleep(attempt * 5_000);
    }
  }
  if (!pages.length)
    log(`  ⚠ /me/accounts listed no Pages after 3 tries${reason ? ` — ${reason}` : " (empty response, no error)"}`);

  const page = configuredId ? pages.find(p => p.id === configuredId) : pages[0];
  if (page) return { id: page.id, name: page.name, token: page.access_token || FB_TOKEN };
  if (pages.length)
    log(`  ⚠ /me/accounts listed ${pages.map(p => p.id).join(", ")}, not the configured ${configuredId}`);

  const me = await call(FB_API, "/me", { params: { fields: "id,name" }, token: FB_TOKEN });
  if (!configuredId || me.id === configuredId) return { id: me.id, name: me.name, token: FB_TOKEN };

  /* /me was something else — a system user whose Pages didn't list. Publishing with
     the system user's own token will almost certainly fail with error 100/33. Go
     ahead anyway so the attempt and its real error are on the record, but name the
     problem first, because the error Facebook returns points at the wrong thing. */
  log(`  ⚠ this token is ${me.name} (${me.id}), not the Page, and the Page did not list.`);
  log(`    Publishing will likely fail. Check Business settings → System users →`);
  log(`    lrn-publisher → Assigned assets, then generate a fresh token.`);
  return { id: configuredId, name: `Page ${configuredId}`, token: FB_TOKEN };
}

/* Three phases. The middle one is the interesting bit: rather than uploading
   bytes, we hand rupload.facebook.com a file_url header and Facebook fetches it
   itself — which is why the clips have to be publicly reachable, and why the
   host must not block the facebookexternalhit user agent. */
async function fbPublish(page, videoUrl, description) {
  const { id: pageId, token } = page;
  const { video_id, upload_url } = await call(FB_API, `/${pageId}/video_reels`, {
    method: "POST", token, params: { upload_phase: "start" },
  });
  log(`    reel ${video_id}`);

  const up = await fetch(upload_url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
  });
  const upBody = await up.text();
  let upJson = {};
  try { upJson = JSON.parse(upBody); } catch { /* non-JSON handled below */ }
  if (!up.ok || upJson.success !== true)
    throw new Error(`Upload phase failed (HTTP ${up.status}): ${upBody.slice(0, 300)}`);
  log(`    fetched by Facebook`);

  if (DRY) { log(`    --dry-run: stopping before publish`); return null; }

  await call(FB_API, `/${pageId}/video_reels`, {
    method: "POST", token,
    params: { video_id, upload_phase: "finish", video_state: "PUBLISHED", description },
  });

  /* Finish returns immediately while Facebook is still encoding. Worth waiting
     to see it land, but a slow encode is not a failure — the reel does appear. */
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await sleep(8_000);
    try {
      const { status } = await call(FB_API, `/${video_id}`, { params: { fields: "status" }, token });
      const phase = status?.video_status ?? status?.processing_phase?.status;
      if (phase === "ready" || status?.publishing_phase?.status === "complete") { log(`    published`); break; }
      if (status?.processing_phase?.status === "error") throw new Error(`Facebook failed to process the video`);
    } catch (e) { log(`    (status check unavailable: ${e.message.split("\n")[0]})`); break; }
  }
  return video_id;
}

/* --------------------------------------------------------------------- run */

if (!IG_TOKEN && !FB_TOKEN)
  die("Neither IG_TOKEN nor FB_PAGE_TOKEN is set — nothing to post to.\n" +
      "  Actions: repo Settings → Secrets and variables → Actions");

const queue = readJson(QUEUE, null) ?? die("No queue.json beside this script.");
const ledger = readJson(LEDGER, { posted: [] });

/* Per-platform, so a Facebook failure retries Facebook tomorrow without
   double-posting to Instagram. */
const entryFor = file => ledger.posted.find(p => p.file === file);
const targets = [
  IG_TOKEN ? "instagram" : null,
  FB_TOKEN ? "facebook" : null,
].filter(Boolean);
const isDone = file => { const e = entryFor(file); return !!e && targets.every(t => e[t]); };

const accounts = {};
if (IG_TOKEN) { const me = await igMe().catch(e => die(e.message)); accounts.instagram = `@${me.username} (${me.user_id})`; accounts.igId = me.user_id; }
if (FB_TOKEN) { const p = await fbResolve(queue.facebookPageId).catch(e => die(e.message)); accounts.facebook = `${p.name} (${p.id})`; accounts.page = p; }

log(`Posting to: ${targets.join(" + ")}`);
if (accounts.instagram) log(`  Instagram  ${accounts.instagram}`);
if (accounts.facebook)  log(`  Facebook   ${accounts.facebook}`);
if (targets.length === 1) log(`  (the other platform's token isn't set — skipping it)`);

if (CHECK) {
  log(`\nChecking ${queue.posts.length} video URLs:`);
  let bad = 0;
  for (const p of queue.posts) {
    const r = await checkVideo(`${queue.baseUrl}/${p.file}`);
    log(`  ${r.ok ? "✓" : "✗"} ${p.file.padEnd(28)} ${r.status} ${r.type} ${r.mb}MB`);
    if (!r.ok) bad++;
  }
  log(bad ? `\n✗ ${bad} URL(s) would fail.` : `\n✓ Tokens, accounts and all videos are good.`);
  process.exit(bad ? 1 : 0);
}

/* A dry run ignores the schedule. The point of a rehearsal is to prove the round
   trip now — waiting until something is due would mean the first real exercise
   of the publish path is the one that goes out live. */
const due = queue.posts
  .filter(p => !isDone(p.file) && (DRY || p.date <= today()))
  .sort((a, b) => a.date.localeCompare(b.date));

if (!due.length) {
  const done = queue.posts.filter(p => isDone(p.file)).length;
  log(`\nNothing due (${today()}). ${done}/${queue.posts.length} posted.`);
  process.exit(0);
}

/* One clip per run. Two Reels landing minutes apart reads as a bot to viewers
   and to the algorithm, and a backlog is better drained slowly. */
const post = due[0];
if (due.length > 1) log(`\n${due.length} outstanding — taking the oldest, the rest follow on subsequent runs.`);

log(`\n${DRY ? "Rehearsing" : "Publishing"} ${post.file} (scheduled ${post.date})`);

const videoUrl = `${queue.baseUrl}/${post.file}`;
const pre = await checkVideo(videoUrl);
if (!pre.ok) die(`${videoUrl}\n  returned HTTP ${pre.status} as ${pre.type}. Meta needs a 200 and a video/* type.`);
log(`  source ok — ${pre.type}, ${pre.mb}MB`);

const entry = entryFor(post.file) ?? { file: post.file, date: post.date };
const failures = [];

/* Write the ledger the instant a platform succeeds, not at the end of the run.
   A post is irreversible; the record of it is the only thing standing between a
   retry and a duplicate. Anything that can kill the process between publishing
   and recording — a crash, a runner timeout, a cancelled job — would otherwise
   leave a live post nobody knows about, and the next run would post it again. */
function saveLedger() {
  if (DRY) return;
  if (!entryFor(post.file) && Object.keys(entry).length > 2) ledger.posted.push(entry);
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
}

for (const platform of targets) {
  if (entry[platform]) { log(`  ${platform}: already posted, skipping`); continue; }
  log(`  ${platform}:`);
  try {
    const id = platform === "instagram"
      ? await igPublish(accounts.igId, videoUrl, post.caption)
      : await fbPublish(accounts.page, videoUrl, post.caption);
    if (!DRY) { entry[platform] = { id, at: new Date().toISOString() }; saveLedger(); }
  } catch (e) {
    /* Deliberately not fatal. One platform being broken should not stop the
       other, and the ledger keeps the failed half retryable tomorrow. */
    log(`  ✗ ${platform} failed:\n${e.message.split("\n").map(l => "    " + l).join("\n")}`);
    failures.push(platform);
  }
}

if (DRY) {
  log(failures.length ? `\n✗ Dry run failed on: ${failures.join(", ")}` : `\n✓ Dry run clean. Nothing was posted.`);
  process.exit(failures.length ? 1 : 0);
}

saveLedger();

const landed = targets.filter(t => entry[t]);
log(`\n${failures.length ? "⚠" : "✓"} ${post.file} → ${landed.join(" + ") || "nowhere"}`);
if (failures.length) log(`  ${failures.join(" and ")} will be retried on the next run.`);
process.exit(failures.length ? 1 : 0);
