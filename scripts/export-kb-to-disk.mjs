#!/usr/bin/env node
/**
 * Export ALL project KB + offer text + every uploaded PDF onto local disk
 * in a clean folder tree, ready to feed into any other bot pipeline
 * (RAG, OpenAI Assistants, local LangChain, etc.).
 *
 * Folder layout produced:
 *   kb-export/
 *     manifest.json
 *     SPECTRA/
 *       kb.md
 *       offer.md
 *       documents/
 *         brochure/Spectra Brochure.pdf
 *         floor_plan/Tower-A.pdf
 *         floor_plan/Tower-B.pdf
 *         unit_plan/1980-East.pdf
 *         ...
 *       _doc_meta.json
 *     BROADWAY/
 *       ...
 *
 * Usage:
 *   API_BASE=https://asbl-crm-api.vercel.app \
 *   SECRET=<INHOUSE_POSTHOOK_SECRET> \
 *   node scripts/export-kb-to-disk.mjs
 *
 * Optional env:
 *   OUTPUT_DIR=./kb-export   (default ./kb-export)
 *   ONLY=SPECTRA,BROADWAY    (comma-separated whitelist)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const API_BASE = process.env.API_BASE || "https://asbl-crm-api.vercel.app";
const SECRET = process.env.SECRET || "";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./kb-export";
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

if (!SECRET) {
  console.error("ERROR: SECRET env var is required (INHOUSE_POSTHOOK_SECRET value).");
  console.error("       export SECRET=...  then re-run.");
  process.exit(1);
}

function sanitiseFilename(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function downloadFile(url, dest) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) {
    throw new Error(`HTTP ${r.status} on ${url}`);
  }
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}

async function main() {
  console.log(`[export] API_BASE=${API_BASE}`);
  console.log(`[export] OUTPUT_DIR=${OUTPUT_DIR}`);
  if (ONLY.length) console.log(`[export] ONLY=${ONLY.join(", ")}`);

  // 1. Pull the full JSON dump
  const url = `${API_BASE}/api/chat-history?action=export-all-kb&secret=${encodeURIComponent(SECRET)}`;
  console.log(`[export] Fetching dump...`);
  const dumpRes = await fetch(url);
  if (!dumpRes.ok) {
    console.error(`[export] dump fetch failed: HTTP ${dumpRes.status} ${await dumpRes.text()}`);
    process.exit(1);
  }
  const dump = await dumpRes.json();
  if (!dump.ok) {
    console.error(`[export] dump returned error: ${dump.error || "unknown"}`);
    process.exit(1);
  }
  console.log(`[export] Got ${dump.project_count} projects, generated_at=${dump.generated_at}`);

  // 2. Top-level manifest with everything (sans heavy text_extract)
  await mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = {
    api_base: API_BASE,
    generated_at: dump.generated_at,
    fetched_at: new Date().toISOString(),
    project_count: dump.project_count,
    projects: dump.projects.map((p) => ({
      project: p.project,
      doc_count: p.documents.length,
      kb_chars: p.kb_text.length,
      facts_chars: p.facts_text.length,
    })),
  };
  await writeFile(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[export] manifest.json written.`);

  // 3. Per-project: kb.md, offer.md, documents/<type>/<file>.pdf
  let totalDocs = 0;
  let totalDownloaded = 0;
  for (const proj of dump.projects) {
    const projName = String(proj.project || "UNKNOWN").toUpperCase();
    if (ONLY.length && !ONLY.includes(projName)) {
      console.log(`[export] SKIP ${projName} (not in ONLY list)`);
      continue;
    }
    const projDir = path.join(OUTPUT_DIR, projName);
    await mkdir(projDir, { recursive: true });

    // 3a. kb.md
    const kbMd =
      `# ${projName} — Knowledge Base\n\n` +
      `_Exported ${dump.generated_at}_\n\n` +
      `${proj.kb_text || "_(no KB text uploaded)_"}\n`;
    await writeFile(path.join(projDir, "kb.md"), kbMd);

    // 3b. offer.md
    const offerMd =
      `# ${projName} — Offer / Pricing Notes\n\n` +
      `_Exported ${dump.generated_at}_\n\n` +
      `${proj.facts_text || "_(no offer text uploaded)_"}\n`;
    await writeFile(path.join(projDir, "offer.md"), offerMd);

    // 3c. document metadata (one file per project so the JSON stays scoped)
    const docMeta = proj.documents.map((d) => ({
      doc_type: d.doc_type,
      filename: d.filename,
      size_label: d.size_label,
      tower: d.tower,
      facing: d.facing,
      unit_size_sft: d.unit_size_sft,
      applies_to_all: d.applies_to_all,
      source_url: d.url,
      text_extract: d.text_extract,
    }));
    await writeFile(path.join(projDir, "_doc_meta.json"), JSON.stringify(docMeta, null, 2));

    // 3d. each PDF into documents/<doc_type>/<sanitised filename>
    const docsDir = path.join(projDir, "documents");
    await mkdir(docsDir, { recursive: true });
    for (const d of proj.documents) {
      totalDocs++;
      if (!d.url) {
        console.warn(`[export] ${projName}/${d.doc_type}: skipped (no URL) ${d.filename}`);
        continue;
      }
      const typeDir = path.join(docsDir, sanitiseFilename(d.doc_type || "misc"));
      await mkdir(typeDir, { recursive: true });
      const fname = sanitiseFilename(d.filename || "document.pdf");
      const dest = path.join(typeDir, fname);
      try {
        await downloadFile(d.url, dest);
        totalDownloaded++;
        process.stdout.write(`  ${projName}/${d.doc_type}/${fname}\n`);
      } catch (err) {
        console.warn(`[export] ${projName}/${d.doc_type}/${fname}: download failed (${err.message})`);
      }
    }
    console.log(`[export] ${projName}: wrote kb.md + offer.md + ${proj.documents.length} docs`);
  }

  console.log("");
  console.log(`[export] DONE.`);
  console.log(`[export]   Projects processed: ${dump.projects.length}`);
  console.log(`[export]   Documents downloaded: ${totalDownloaded} / ${totalDocs}`);
  console.log(`[export]   Output: ${path.resolve(OUTPUT_DIR)}`);
}

main().catch((err) => {
  console.error("[export] FATAL:", err);
  process.exit(1);
});
