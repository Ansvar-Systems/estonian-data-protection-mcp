#!/usr/bin/env tsx
/**
 * AKI (Andmekaitse Inspektsioon) ingestion crawler.
 *
 * Scrapes aki.ee for:
 *   - Decisions (ettekirjutused, vaideotsused) — enforcement orders, warnings, sanctions
 *   - Guidance documents (juhendid) — practical data protection guidance
 *
 * Populates the SQLite database used by the MCP server.
 *
 * Data sources:
 *   1. aki.ee/ettekirjutused               — Enforcement orders (PDF links per year)
 *   2. aki.ee/meist/aki-tegevus/aki-otsused — Appeal decisions
 *   3. aki.ee/kiirelt-katte/juhendid        — Guidance listing page
 *   4. Individual guideline detail pages     — Full text of each guide
 *
 * Usage:
 *   npx tsx scripts/ingest-aki.ts                # Full ingestion
 *   npx tsx scripts/ingest-aki.ts --resume       # Skip already-ingested references
 *   npx tsx scripts/ingest-aki.ts --dry-run      # Parse and log, do not write to DB
 *   npx tsx scripts/ingest-aki.ts --force        # Drop existing data and re-ingest
 *
 * Environment:
 *   AKI_DB_PATH      — SQLite database path (default: data/aki.db)
 *   AKI_USER_AGENT   — Custom User-Agent header (default: built-in)
 *   AKI_RATE_LIMIT   — Milliseconds between requests (default: 1500)
 *   AKI_MAX_RETRIES  — Max retry attempts per request (default: 3)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// cheerio — loaded dynamically so the script fails fast with a clear message
// ---------------------------------------------------------------------------

let cheerio: typeof import("cheerio");
try {
  cheerio = await import("cheerio");
} catch {
  console.error(
    "Missing dependency: cheerio\n" +
      "Install it with:  npm install --save-dev cheerio @types/cheerio\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["AKI_DB_PATH"] ?? "data/aki.db";
const USER_AGENT =
  process.env["AKI_USER_AGENT"] ??
  "AnsvarAKICrawler/1.0 (+https://ansvar.eu; data-protection-research)";
const RATE_LIMIT_MS = parseInt(
  process.env["AKI_RATE_LIMIT"] ?? "1500",
  10,
);
const MAX_RETRIES = parseInt(
  process.env["AKI_MAX_RETRIES"] ?? "3",
  10,
);

const BASE_URL = "https://www.aki.ee";

// CLI flags
const args = new Set(process.argv.slice(2));
const FLAG_RESUME = args.has("--resume");
const FLAG_DRY_RUN = args.has("--dry-run");
const FLAG_FORCE = args.has("--force");

// ---------------------------------------------------------------------------
// Curated guideline URLs — AKI publishes guidance on individual pages
//
// The guidelines listing at /kiirelt-katte/juhendid links to detail pages.
// We maintain a curated index to ensure complete coverage even if the
// listing page structure changes.
// ---------------------------------------------------------------------------

interface GuidelineSource {
  url: string;
  reference?: string;
  type?: "juhend" | "ringkiri" | "uhisjuhend" | "kkk";
}

const KNOWN_GUIDELINES: GuidelineSource[] = [
  // Primary guides (juhendid)
  { url: "/isikuandmed/juhendid/isikuandmete-tootleja-uldjuhend", type: "juhend" },
  { url: "/avaliku-teabe-seaduse-uldjuhend", type: "juhend" },
  { url: "/isikuandmete-tootlemine-toosuhetes", type: "juhend" },
  { url: "/isikuandmed/juhendid/oigustatud-huvi", type: "juhend" },
  { url: "/isikuandmed/juhendid/juhend-kaamerate-kasutamise-kohta", type: "juhend" },
  { url: "/isikuandmed/juhendid-ja-materjalid/maksehairete-avaldamise-juhend", type: "juhend" },
  // Joint guides (ühisjuhendid)
  { url: "/uhisjuhend-abivajavast-lapsest-teatamine-ja-andmekaitse", type: "uhisjuhend" },
  { url: "/uhisjuhend-mehitamata-ohusoiduk", type: "uhisjuhend" },
  // Circulars (ringkirjad)
  { url: "/ringkiri-koolidele-ja-oppekorralduskeskkondadele-isikuandmete-sailitamise-kohta-2024", type: "ringkiri" },
  // Topical guidance pages
  { url: "/isikuandmed/kkk/moisted", type: "kkk" },
  { url: "/isikuandmed/kkk/tervishoid", type: "kkk" },
  { url: "/isikuandmed/juhendid-ja-materjalid/isikuandmete-tootlemine-toosuhtes", type: "juhend" },
];

// ---------------------------------------------------------------------------
// Topic detection — maps Estonian keywords to topic IDs
// ---------------------------------------------------------------------------

interface TopicRule {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
  /** Keywords to match in title + summary + full_text (case-insensitive). */
  keywords: string[];
}

const TOPIC_RULES: TopicRule[] = [
  {
    id: "cookies",
    name_local: "Küpsised ja jälgijad",
    name_en: "Cookies and trackers",
    description:
      "Küpsiste ja muude jälgijate kasutamine kasutajate seadmetes (IKÜM art 6).",
    keywords: [
      "küpsis", "cookie", "jälgija", "tracker",
      "analüütika", "analytics", "reklaamiküpsis",
    ],
  },
  {
    id: "employee_monitoring",
    name_local: "Töötajate jälgimine",
    name_en: "Employee monitoring",
    description:
      "Töötajate andmete töötlemine ja jälgimine töökohal.",
    keywords: [
      "töötaja", "employee", "töösuhe", "employment",
      "jälgimine", "monitoring", "gps", "asukoht",
      "töökoh", "workplace", "tööandja",
    ],
  },
  {
    id: "video_surveillance",
    name_local: "Videojälgimine",
    name_en: "Video surveillance",
    description:
      "Videojälgimissüsteemide kasutamine ja isikuandmete kaitse (IKÜM art 6).",
    keywords: [
      "videojälgimine", "video surveillance", "kaamera",
      "camera", "videovalve", "turvakaamera", "salvestav",
    ],
  },
  {
    id: "data_breach",
    name_local: "Andmelekke teavitamine",
    name_en: "Data breach notification",
    description:
      "Isikuandmete lekke teavitamine AKI-le ja andmesubjektidele (IKÜM art 33–34).",
    keywords: [
      "andmeleke", "data breach", "leke", "breach",
      "teavitamine", "notification", "72 tundi", "72 hours",
      "intsident", "incident", "küberrünnak",
    ],
  },
  {
    id: "consent",
    name_local: "Nõusolek",
    name_en: "Consent",
    description:
      "Isikuandmete töötlemiseks nõusoleku saamine, kehtivus ja tagasivõtmine (IKÜM art 7).",
    keywords: [
      "nõusolek", "consent", "opt-in", "opt-out",
      "keeldumine", "tagasivõtmine", "nõustumine",
    ],
  },
  {
    id: "dpia",
    name_local: "Andmekaitsealane mõjuhinnang",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description:
      "Andmekaitsealane mõjuhinnang kõrge riskiga töötlemise jaoks (IKÜM art 35).",
    keywords: [
      "mõjuhinnang", "impact assessment", "dpia",
      "kõrge risk", "high risk",
    ],
  },
  {
    id: "transfers",
    name_local: "Rahvusvahelised andmeedastused",
    name_en: "International data transfers",
    description:
      "Isikuandmete edastamine kolmandatesse riikidesse või rahvusvahelistele organisatsioonidele (IKÜM art 44–49).",
    keywords: [
      "andmeedastus", "transfer", "kolmas riik", "third country",
      "piisavusotsus", "adequacy", "schrems",
      "tüüpklauslid", "standard contractual", "bcr",
    ],
  },
  {
    id: "data_subject_rights",
    name_local: "Andmesubjektide õigused",
    name_en: "Data subject rights",
    description:
      "Juurdepääsu-, parandamis-, kustutamis- ja muude õiguste teostamine (IKÜM art 15–22).",
    keywords: [
      "andmesubjekti õigus", "data subject right", "juurdepääsuõigus",
      "right of access", "parandamisõigus", "rectification",
      "kustutamisõigus", "erasure", "ülekandmisõigus", "portability",
      "vastuväide", "right to object", "õigus olla unustatud",
    ],
  },
  {
    id: "direct_marketing",
    name_local: "Otseturundus",
    name_en: "Direct marketing",
    description:
      "Elektrooniline otseturundus ja isikuandmete töötlemine turunduseks.",
    keywords: [
      "otseturundus", "direct marketing", "turundus",
      "marketing", "e-kiri", "email", "reklaam",
      "sms", "loobumi",
    ],
  },
  {
    id: "health_data",
    name_local: "Terviseandmed",
    name_en: "Health data",
    description:
      "Terviseandmete töötlemine — eriliigilised isikuandmed (IKÜM art 9).",
    keywords: [
      "tervise", "health", "patsien", "patient",
      "haigla", "hospital", "meditsiini", "medical",
      "apteek", "pharmacy", "ravim",
    ],
  },
  {
    id: "children",
    name_local: "Laste andmekaitse",
    name_en: "Children's data protection",
    description:
      "Laste isikuandmete kaitse, eriti veebiteenustes (IKÜM art 8).",
    keywords: [
      "laps", "child", "children", "alaealine", "minor",
      "kool", "school", "õpilane", "student",
    ],
  },
  {
    id: "data_security",
    name_local: "Andmeturve",
    name_en: "Data security",
    description:
      "Tehnilised ja organisatoorsed meetmed isikuandmete kaitsmiseks (IKÜM art 32).",
    keywords: [
      "andmeturve", "data security", "krüpteerimine", "encryption",
      "kaitsemeetmed", "safeguard", "parool", "password",
      "juurdepääsu kontroll", "access control", "turvameetmed",
    ],
  },
  {
    id: "public_information",
    name_local: "Avalik teave",
    name_en: "Public information",
    description:
      "Avaliku teabe seadus ja teabele juurdepääsu tagamine.",
    keywords: [
      "avalik teave", "public information", "teabenõue",
      "information request", "avaliku teabe seadus",
      "asutusesisene", "teabevaldaja",
    ],
  },
  {
    id: "legitimate_interest",
    name_local: "Õigustatud huvi",
    name_en: "Legitimate interest",
    description:
      "Õigustatud huvi kasutamine isikuandmete töötlemise alusena (IKÜM art 6(1)(f)).",
    keywords: [
      "õigustatud huvi", "legitimate interest",
      "kaalumine", "balancing test",
    ],
  },
];

// ---------------------------------------------------------------------------
// GDPR article detection — extracts article numbers from Estonian text
// ---------------------------------------------------------------------------

const GDPR_ARTICLE_PATTERNS = [
  // Estonian: "artikkel 5", "art 32", "artiklid 33 ja 34"
  /(?:artikkel|artiklid|art\.?)\s*(\d+(?:\s*(?:ja|,)\s*\d+)*)/gi,
  // Estonian: "IKÜM artikkel 5", "IKÜM art 32"
  /IKÜM\s+(?:artikkel|art\.?)\s*(\d+(?:\s*(?:ja|,)\s*\d+)*)/gi,
  // Parenthetical: "(IKÜM art 33–34)", "(art. 5 IKÜM)"
  /\((?:IKÜM|GDPR)\s*(?:artikkel|art\.?)\s*(\d+(?:\s*[-–,]\s*\d+)*)\)/gi,
  /\((?:artikkel|art\.?)\s*(\d+(?:\s*[-–,]\s*\d+)*)\s*(?:IKÜM|GDPR)\)/gi,
  // English fallback: "Article 5", "Art. 32"
  /\bArt(?:icle|\.)\s*(\d+(?:\s*(?:and|,\s*\d+))*)/gi,
  // IKS (isikuandmete kaitse seadus) references: "IKS § 5"
  /IKS\s*§\s*(\d+)/gi,
];

function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  for (const pattern of GDPR_ARTICLE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const numStr = match[1];
      if (!numStr) continue;

      // Split compound references: "5, 6 ja 13" or "33–34" or "5 and 6"
      const nums = numStr
        .split(/[,\s]+(?:ja|and|[-–])\s*|[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const n of nums) {
        const parsed = parseInt(n, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 99) {
          articles.add(String(parsed));
        }
      }
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// ---------------------------------------------------------------------------
// Topic detection
// ---------------------------------------------------------------------------

function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const rule of TOPIC_RULES) {
    const hit = rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (hit) {
      matched.push(rule.id);
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Fine amount extraction — Estonian amounts use space as thousands separator
// ---------------------------------------------------------------------------

const FINE_PATTERNS = [
  // "8 000 EUR", "16 000 eurot", "28 000 euro"
  /(\d{1,3}(?:\s\d{3})*)\s*(?:EUR|euro)/gi,
  // "EUR 8 000", "EUR 16 000"
  /EUR\s*(\d{1,3}(?:[\s.]\d{3})*)/gi,
  // "€ 8 000", "€8.000"
  /€\s*(\d{1,3}(?:[\s.]\d{3})*)/gi,
  // "trahv 8000", "trahvi 16 000"
  /trahvi?\s+(\d{1,3}(?:\s\d{3})*)/gi,
];

function extractFineAmount(text: string): number | null {
  let maxFine = 0;

  for (const pattern of FINE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const rawNum = match[1];
      if (!rawNum) continue;

      const normalized = rawNum.replace(/[\s.]/g, "");
      const amount = parseInt(normalized, 10);

      if (!isNaN(amount) && amount > maxFine) {
        maxFine = amount;
      }
    }
  }

  return maxFine > 0 ? maxFine : null;
}

// ---------------------------------------------------------------------------
// Date extraction — Estonian date formats
// ---------------------------------------------------------------------------

const ESTONIAN_MONTHS: Record<string, string> = {
  jaanuar: "01", veebruar: "02", märts: "03", aprill: "04",
  mai: "05", juuni: "06", juuli: "07", august: "08",
  september: "09", oktoober: "10", november: "11", detsember: "12",
};

function extractDate(text: string): string | null {
  // Estonian: "18. aprill 2022", "14. märts 2023"
  const etMonthMatch = text.match(
    /(\d{1,2})\.\s*(jaanuar|veebruar|märts|aprill|mai|juuni|juuli|august|september|oktoober|november|detsember)i?\s+(\d{4})/i,
  );
  if (etMonthMatch) {
    const day = (etMonthMatch[1] ?? "").padStart(2, "0");
    const monthKey = (etMonthMatch[2] ?? "").toLowerCase().replace(/i$/, "");
    const month = ESTONIAN_MONTHS[monthKey];
    const year = etMonthMatch[3];
    if (month && year) {
      return `${year}-${month}-${day}`;
    }
  }

  // Estonian numeric: "18.04.2022" or "14.3.2023"
  const etNumMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (etNumMatch) {
    const day = (etNumMatch[1] ?? "").padStart(2, "0");
    const month = (etNumMatch[2] ?? "").padStart(2, "0");
    const year = etNumMatch[3];
    if (year) {
      return `${year}-${month}-${day}`;
    }
  }

  // ISO date: "2023-09-13"
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1] ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entity name extraction from decision title
// ---------------------------------------------------------------------------

function extractEntityFromTitle(title: string): string | null {
  // Pattern: "... asjas nr 2.1-1 24 1083-2664-12" — entity before "asjas"
  // Or: "Ettekirjutus-hoiatus isikuandmete kaitse asjas"
  // The entity is often in the table metadata, not the title; return null for titles

  // Try to find entity names ending with common suffixes
  const corpMatch = title.match(
    /(?:^|\s)([\wäöüõÄÖÜÕ][\w\säöüõÄÖÜÕ]*?\s*(?:OÜ|AS|MTÜ|SA|SE|SIA|AB|GmbH|Ltd))\b/,
  );
  if (corpMatch && corpMatch[1]) {
    return corpMatch[1].trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Decision type inference from title and content
// ---------------------------------------------------------------------------

function inferDecisionType(title: string, content: string): string {
  const lower = (title + " " + content.slice(0, 500)).toLowerCase();
  if (lower.includes("trahv") || lower.includes("sunniraha") || lower.includes("fine")) {
    return "sanction";
  }
  if (lower.includes("hoiatus") || lower.includes("warning")) {
    return "warning";
  }
  if (lower.includes("ettekirjutus")) {
    return "order";
  }
  if (lower.includes("vaideotsus") || lower.includes("appeal")) {
    return "appeal_decision";
  }
  if (lower.includes("menetluse lõpetamine") || lower.includes("lõpetatud")) {
    return "closed";
  }
  return "decision";
}

// ---------------------------------------------------------------------------
// Reference generation from case number or slug
// ---------------------------------------------------------------------------

function referenceFromCaseNumber(caseNumber: string): string {
  // Clean the case number: "2.1-1 24 1083-2664-12" → "AKI-2.1-1-24-1083-2664-12"
  const cleaned = caseNumber
    .replace(/\s+/g, "-")
    .replace(/[^\w.\-]/g, "")
    .trim();
  return `AKI-${cleaned}`;
}

function referenceFromSlug(url: string): string {
  const slug = url.split("/").pop() ?? url;
  const cleaned = slug
    .replace(/[^a-zA-Z0-9äöüõÄÖÜÕ-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase()
    .slice(0, 80);
  return `AKI-${cleaned}`;
}

function referenceFromPdfFilename(url: string): string {
  const filename = url.split("/").pop() ?? url;
  const cleaned = filename
    .replace(/\.pdf$/i, "")
    .replace(/[^a-zA-Z0-9äöüõÄÖÜÕ-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase()
    .slice(0, 80);
  return `AKI-${cleaned}`;
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry, rate limiting, and proper headers
// ---------------------------------------------------------------------------

let lastFetchTime = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url: string): Promise<Response | null> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastFetchTime = Date.now();
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "et-EE,et;q=0.9,en;q=0.5",
        },
        redirect: "follow",
      });

      if (res.ok) {
        return res;
      }

      // 429 Too Many Requests — back off
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        console.warn(`  Rate limited (429), waiting ${retryAfter}s before retry ${attempt}/${MAX_RETRIES}`);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 403 Forbidden — skip after 1 attempt
      if (res.status === 403) {
        console.warn(`  Blocked (403): ${url}`);
        return null;
      }

      // 404 Not Found
      if (res.status === 404) {
        console.warn(`  Not found (404): ${url}`);
        return null;
      }

      // Server errors — retry with backoff
      if (res.status >= 500) {
        console.warn(`  Server error (${res.status}), retry ${attempt}/${MAX_RETRIES}: ${url}`);
        await sleep(2000 * attempt);
        continue;
      }

      // Unexpected status
      console.warn(`  HTTP ${res.status} for ${url}`);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Network error (attempt ${attempt}/${MAX_RETRIES}): ${msg}`);
      if (attempt < MAX_RETRIES) {
        await sleep(2000 * attempt);
      }
    }
  }

  console.error(`  Failed after ${MAX_RETRIES} retries: ${url}`);
  return null;
}

// ---------------------------------------------------------------------------
// PDF text extraction — basic extraction via HTTP fetch
//
// AKI decisions are published as PDFs. We download the PDF content and
// extract whatever text is accessible. For full-text extraction from
// complex PDFs, consider post-processing with a dedicated PDF library.
// ---------------------------------------------------------------------------

async function fetchPdfText(url: string): Promise<string | null> {
  const res = await rateLimitedFetch(url);
  if (!res) return null;

  // We cannot parse PDF binary in a simple Node script without a PDF library.
  // Return null — the caller will use the table metadata as the full_text.
  // A future enhancement can add pdf-parse or pdfjs-dist for full extraction.
  return null;
}

// ---------------------------------------------------------------------------
// HTML page parsing — aki.ee (Drupal CMS)
// ---------------------------------------------------------------------------

interface ParsedDecisionRow {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  subject: string | null;
  legal_norms: string | null;
  pdf_url: string | null;
  full_text: string;
}

/**
 * Parse the ettekirjutused (enforcement orders) listing page.
 *
 * The page uses year-based accordion sections. Each section contains a table
 * with columns: Asja nr (case number), Kuupäev (date), Õigusnormid (legal norms),
 * Adressaat (addressee), Teema (subject), Dokument (PDF link).
 *
 * Older year sections (2021 and earlier) may use a simpler list format with
 * just document links and titles.
 */
function parseEttekirjutusedPage(html: string): ParsedDecisionRow[] {
  const $ = cheerio.load(html);
  const decisions: ParsedDecisionRow[] = [];

  // Strategy 1: Parse structured tables (2024–2025 format)
  // Tables contain rows with case data across multiple columns
  $("table").each((_tableIdx, table) => {
    const rows = $(table).find("tr");
    rows.each((_rowIdx, row) => {
      const cells = $(row).find("td");
      if (cells.length < 3) return; // Skip header rows or malformed rows

      // Extract cell texts
      const cellTexts: string[] = [];
      cells.each((_i, cell) => {
        cellTexts.push($(cell).text().trim());
      });

      // Find PDF link in this row
      let pdfUrl: string | null = null;
      let pdfTitle: string | null = null;
      const pdfLinks = $(row).find("a[href*='.pdf']");
      if (pdfLinks.length > 0) {
        const href = pdfLinks.first().attr("href");
        if (href) {
          pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
          pdfTitle = pdfLinks.first().text().trim();
        }
      }

      // Determine which column is which based on content patterns
      // Case number pattern: "2.1-1 24 1083" or "2.1.-1/23/53"
      let caseNumber: string | null = null;
      let dateStr: string | null = null;
      let legalNorms: string | null = null;
      let addressee: string | null = null;
      let subject: string | null = null;

      for (const text of cellTexts) {
        if (!text) continue;

        // Case number detection: starts with "2.1" or contains case-like pattern
        if (/^2\.\d/.test(text) || /^\d+\.\d+-\d/.test(text)) {
          if (!caseNumber) caseNumber = text;
          continue;
        }

        // Date detection
        if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(text)) {
          if (!dateStr) dateStr = text;
          continue;
        }

        // Legal norms: contains "IKÜM", "IKS", "art", "§"
        if (/IKÜM|IKS|art\b|§|AvTS/.test(text)) {
          if (!legalNorms) legalNorms = text;
          continue;
        }

        // Subject: common subjects like "Isikuandmed", "Kaamerad", etc.
        if (/^(?:Isikuandm|Kaamerad|Avalik teave|Otseturundus|Küpsised|Andmeleke|Meedia)/i.test(text)) {
          if (!subject) subject = text;
          continue;
        }

        // Remaining text is likely the addressee
        if (!addressee && text.length > 2 && text.length < 200) {
          addressee = text;
        }
      }

      // Build the title from available data
      const titleParts: string[] = [];
      if (pdfTitle && pdfTitle.length > 10) {
        // Use the PDF link text as title (often contains the full decision title)
        titleParts.push(pdfTitle.replace(/\s*\|\s*\d+.*$/, "").trim());
      } else {
        titleParts.push("Ettekirjutus");
        if (subject) titleParts.push(`— ${subject}`);
        if (addressee) titleParts.push(`— ${addressee}`);
      }
      const title = titleParts.join(" ");

      // Generate reference
      const reference = caseNumber
        ? referenceFromCaseNumber(caseNumber)
        : pdfUrl
          ? referenceFromPdfFilename(pdfUrl)
          : referenceFromSlug(title);

      // Parse date
      const date = dateStr ? extractDate(dateStr) : null;

      // Build full_text from all available content
      const textParts = [title];
      if (caseNumber) textParts.push(`Asja nr: ${caseNumber}`);
      if (dateStr) textParts.push(`Kuupäev: ${dateStr}`);
      if (legalNorms) textParts.push(`Õigusnormid: ${legalNorms}`);
      if (addressee) textParts.push(`Adressaat: ${addressee}`);
      if (subject) textParts.push(`Teema: ${subject}`);
      const fullText = textParts.join("\n");

      // Infer type from title and content
      const type = inferDecisionType(title, fullText);

      // Extract fine amount from all text
      const fineAmount = extractFineAmount(fullText);

      decisions.push({
        reference,
        title,
        date,
        type,
        entity_name: addressee,
        fine_amount: fineAmount,
        subject,
        legal_norms: legalNorms,
        pdf_url: pdfUrl,
        full_text: fullText,
      });
    });
  });

  // Strategy 2: Parse simple link lists (older year sections)
  // These are lists of <a> tags pointing to PDFs with descriptive text
  $("a[href*='.pdf']").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    const linkText = $(el).text().trim();

    // Skip if we already captured this PDF from the table parsing
    const existingPdf = decisions.find((d) => d.pdf_url === fullUrl);
    if (existingPdf) return;

    // Skip non-decision PDFs (e.g. annual reports, general docs)
    if (!linkText || linkText.length < 10) return;

    const reference = referenceFromPdfFilename(href);
    const title = linkText.replace(/\s*\|\s*\d+.*$/, "").trim();
    const date = extractDate(linkText) ?? extractDate(href);
    const type = inferDecisionType(title, linkText);

    decisions.push({
      reference,
      title,
      date,
      type,
      entity_name: extractEntityFromTitle(title),
      fine_amount: extractFineAmount(linkText),
      subject: null,
      legal_norms: null,
      pdf_url: fullUrl,
      full_text: title,
    });
  });

  return decisions;
}

// ---------------------------------------------------------------------------
// AKI otsused (appeal decisions) page parsing
// ---------------------------------------------------------------------------

function parseAkiOtsusedPage(html: string): ParsedDecisionRow[] {
  const $ = cheerio.load(html);
  const decisions: ParsedDecisionRow[] = [];

  // Appeal decisions follow a similar structure to ettekirjutused
  $("a[href*='.pdf']").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    const linkText = $(el).text().trim();

    if (!linkText || linkText.length < 5) return;

    const reference = referenceFromPdfFilename(href);
    const title = linkText.replace(/\s*\|\s*\d+.*$/, "").trim();
    const date = extractDate(linkText) ?? extractDate(href);

    decisions.push({
      reference,
      title,
      date,
      type: "appeal_decision",
      entity_name: extractEntityFromTitle(title),
      fine_amount: extractFineAmount(linkText),
      subject: null,
      legal_norms: null,
      pdf_url: fullUrl,
      full_text: title,
    });
  });

  return decisions;
}

// ---------------------------------------------------------------------------
// Guideline listing page parsing
// ---------------------------------------------------------------------------

interface DiscoveredGuideline {
  url: string;
  title: string;
  summary: string | null;
}

function parseGuidelinesListPage(html: string): DiscoveredGuideline[] {
  const $ = cheerio.load(html);
  const guidelines: DiscoveredGuideline[] = [];

  // Guidelines page uses h2 headings followed by description paragraphs
  // and "Loe edasi" (Read more) links
  $("h2").each((_i, h2) => {
    const title = $(h2).text().trim();
    if (!title || title.length < 5) return;

    // Skip page title and non-guide headings
    if (title.toLowerCase().includes("juhendid") && title.length < 15) return;

    // Look for the "Loe edasi" link after this heading
    let url: string | null = null;
    let summary: string | null = null;

    // Check next siblings for summary paragraph and link
    let nextEl = $(h2).next();
    for (let n = 0; n < 5 && nextEl.length > 0; n++) {
      const tagName = nextEl.prop("tagName")?.toLowerCase();

      if (tagName === "p") {
        const pText = nextEl.text().trim();
        if (pText.length > 20 && !summary) {
          summary = pText;
        }
      }

      if (tagName === "a" || nextEl.find("a").length > 0) {
        const link = tagName === "a" ? nextEl : nextEl.find("a").first();
        const href = link.attr("href");
        if (href && !href.startsWith("#") && !href.startsWith("http")) {
          url = href;
          break;
        }
      }

      // Stop at next heading
      if (tagName === "h2" || tagName === "h1" || tagName === "h3") break;

      nextEl = nextEl.next();
    }

    // Also check for links within the heading itself
    if (!url) {
      const headingLink = $(h2).find("a[href]").first();
      if (headingLink.length > 0) {
        url = headingLink.attr("href") ?? null;
      }
    }

    if (url) {
      guidelines.push({ url, title, summary });
    }
  });

  // Also find links to guideline detail pages that we may have missed
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (href.startsWith("#") || href.startsWith("http") || href.includes(".pdf")) return;

    // Match guideline-like paths
    if (
      href.includes("/juhendid/") ||
      href.includes("/juhendid-ja-materjalid/") ||
      href.includes("uldjuhend") ||
      href.includes("uhisjuhend")
    ) {
      const linkText = $(el).text().trim();
      if (linkText === "Loe edasi" || linkText.length < 5) return;

      const existing = guidelines.find((g) => g.url === href);
      if (!existing) {
        guidelines.push({ url: href, title: linkText, summary: null });
      }
    }
  });

  return guidelines;
}

// ---------------------------------------------------------------------------
// Guideline detail page parsing
// ---------------------------------------------------------------------------

interface ParsedGuideline {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  summary: string | null;
  full_text: string;
  topics: string[];
  language: string;
}

function parseGuidelineDetailPage(html: string, sourceUrl: string, sourceType?: string): ParsedGuideline | null {
  const $ = cheerio.load(html);

  // -- Title --
  let title =
    $("h1").first().text().trim() ||
    $("title").text().replace(/\s*\|\s*Andmekaitse Inspektsioon.*$/i, "").trim();

  if (!title) {
    console.warn(`  No title found on ${sourceUrl}`);
    return null;
  }

  // -- Date --
  let date: string | null = null;

  // Look for "Last updated: DD.MM.YYYY" or "Viimati uuendatud: DD.MM.YYYY"
  const pageText = $.text();
  const updatedMatch = pageText.match(
    /(?:Last updated|Viimati uuendatud|Uuendatud)[:\s]*(\d{1,2}\.\d{1,2}\.\d{4})/i,
  );
  if (updatedMatch && updatedMatch[1]) {
    date = extractDate(updatedMatch[1]);
  }

  // Try meta tags
  if (!date) {
    const metaDate =
      $('meta[property="article:modified_time"]').attr("content") ??
      $('meta[property="article:published_time"]').attr("content");
    if (metaDate) {
      date = metaDate.slice(0, 10);
    }
  }

  // -- Body text --
  // Drupal typically uses .node__content, .field--name-body, article, or main
  const bodySelectors = [
    ".node__content",
    ".field--name-body",
    "article .content",
    "article",
    "main .region-content",
    "main",
  ];

  let bodyText = "";
  for (const selector of bodySelectors) {
    const el = $(selector).first();
    if (el.length > 0) {
      // Clone and strip non-content elements
      const clone = el.clone();
      clone.find("nav, header, footer, script, style, .breadcrumb, .pager, .sidebar, .tabs, .menu").remove();
      const text = clone.text().replace(/\s+/g, " ").trim();
      if (text.length > bodyText.length) {
        bodyText = text;
      }
    }
  }

  if (!bodyText || bodyText.length < 30) {
    console.warn(`  Body text too short (${bodyText.length} chars) on ${sourceUrl}`);
    return null;
  }

  // -- Summary --
  let summary: string | null = null;
  for (const selector of [".field--name-body p", "article p", "main p"]) {
    const firstP = $(selector).first().text().trim();
    if (firstP && firstP.length > 30 && firstP.length < 1500) {
      summary = firstP;
      break;
    }
  }

  // -- PDF download --
  // Check if there's a downloadable PDF version and note it
  const pdfLink = $("a[href*='.pdf']").first().attr("href");
  if (pdfLink) {
    const pdfUrl = pdfLink.startsWith("http") ? pdfLink : `${BASE_URL}${pdfLink}`;
    bodyText += `\n\nPDF: ${pdfUrl}`;
  }

  // Extract date from body if not found in metadata
  if (!date) {
    date = extractDate(bodyText);
  }

  // -- Reference --
  const reference = referenceFromSlug(sourceUrl);

  // -- Type --
  const type = sourceType ?? "juhend";

  // -- Topics and GDPR articles --
  const combinedText = `${title} ${summary ?? ""} ${bodyText}`;
  const topics = detectTopics(combinedText);

  return {
    reference,
    title,
    date,
    type,
    summary,
    full_text: bodyText,
    topics,
    language: "et",
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function getExistingReferences(db: Database.Database): Set<string> {
  const refs = new Set<string>();
  const decRefs = db.prepare("SELECT reference FROM decisions").all() as { reference: string }[];
  for (const r of decRefs) {
    refs.add(r.reference);
  }
  const guideRefs = db.prepare("SELECT reference FROM guidelines").all() as { reference: string | null }[];
  for (const r of guideRefs) {
    if (r.reference) refs.add(r.reference);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

interface IngestCounters {
  decisionsFound: number;
  decisionsInserted: number;
  decisionsSkipped: number;
  guidelinesFound: number;
  guidelinesInserted: number;
  guidelinesSkipped: number;
  topicsInserted: number;
  fetchErrors: number;
}

const counters: IngestCounters = {
  decisionsFound: 0,
  decisionsInserted: 0,
  decisionsSkipped: 0,
  guidelinesFound: 0,
  guidelinesInserted: 0,
  guidelinesSkipped: 0,
  topicsInserted: 0,
  fetchErrors: 0,
};

// ---------------------------------------------------------------------------
// Main ingestion logic
// ---------------------------------------------------------------------------

async function ingestDecisions(db: Database.Database, existingRefs: Set<string>): Promise<void> {
  console.log("\n--- Ingesting decisions from ettekirjutused page ---");

  const ettekirjutusedUrl = `${BASE_URL}/ettekirjutused`;
  console.log(`Fetching: ${ettekirjutusedUrl}`);
  const res = await rateLimitedFetch(ettekirjutusedUrl);
  if (!res) {
    console.error("Failed to fetch ettekirjutused page");
    counters.fetchErrors++;
    return;
  }

  const html = await res.text();
  const decisions = parseEttekirjutusedPage(html);
  console.log(`  Found ${decisions.length} decisions on ettekirjutused page`);
  counters.decisionsFound += decisions.length;

  // Also try the AKI otsused (appeal decisions) page
  console.log("\n--- Ingesting appeal decisions from AKI otsused page ---");
  const otsusedUrl = `${BASE_URL}/meist/aki-tegevus/aki-otsused`;
  console.log(`Fetching: ${otsusedUrl}`);
  const otsusedRes = await rateLimitedFetch(otsusedUrl);
  if (otsusedRes) {
    const otsusedHtml = await otsusedRes.text();
    const appealDecisions = parseAkiOtsusedPage(otsusedHtml);
    console.log(`  Found ${appealDecisions.length} appeal decisions`);
    counters.decisionsFound += appealDecisions.length;
    decisions.push(...appealDecisions);
  } else {
    console.warn("  Failed to fetch AKI otsused page");
    counters.fetchErrors++;
  }

  // Deduplicate by reference
  const seen = new Set<string>();
  const uniqueDecisions = decisions.filter((d) => {
    if (seen.has(d.reference)) return false;
    seen.add(d.reference);
    return true;
  });

  console.log(`\n  Unique decisions after dedup: ${uniqueDecisions.length}`);

  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const d of uniqueDecisions) {
    if (FLAG_RESUME && existingRefs.has(d.reference)) {
      counters.decisionsSkipped++;
      continue;
    }

    // Detect topics and GDPR articles from all available text
    const combinedText = `${d.title} ${d.full_text} ${d.subject ?? ""} ${d.legal_norms ?? ""}`;
    const topics = detectTopics(combinedText);
    const gdprArticles = extractGdprArticles(combinedText);

    // Build summary from metadata
    const summaryParts: string[] = [];
    if (d.entity_name) summaryParts.push(`Adressaat: ${d.entity_name}.`);
    if (d.subject) summaryParts.push(`Teema: ${d.subject}.`);
    if (d.fine_amount) summaryParts.push(`Trahv: ${d.fine_amount.toLocaleString("et-EE")} EUR.`);
    if (d.legal_norms) summaryParts.push(`Õigusnormid: ${d.legal_norms}.`);
    const summary = summaryParts.length > 0 ? summaryParts.join(" ") : null;

    if (FLAG_DRY_RUN) {
      console.log(`  [DRY RUN] Would insert decision: ${d.reference} — ${d.title.slice(0, 80)}`);
      counters.decisionsInserted++;
      continue;
    }

    try {
      insertDecision.run(
        d.reference,
        d.title,
        d.date,
        d.type,
        d.entity_name,
        d.fine_amount,
        summary,
        d.full_text,
        JSON.stringify(topics),
        JSON.stringify(gdprArticles),
        "final",
      );
      counters.decisionsInserted++;
      console.log(`  Inserted: ${d.reference} — ${d.title.slice(0, 60)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        counters.decisionsSkipped++;
      } else {
        console.error(`  DB error inserting ${d.reference}: ${msg}`);
      }
    }
  }
}

async function ingestGuidelines(db: Database.Database, existingRefs: Set<string>): Promise<void> {
  console.log("\n--- Ingesting guidelines ---");

  // Step 1: Discover guidelines from the listing page
  const listingUrl = `${BASE_URL}/kiirelt-katte/juhendid`;
  console.log(`Fetching guideline listing: ${listingUrl}`);
  const listRes = await rateLimitedFetch(listingUrl);

  const discoveredUrls = new Set<string>();

  if (listRes) {
    const listHtml = await listRes.text();
    const discovered = parseGuidelinesListPage(listHtml);
    console.log(`  Discovered ${discovered.length} guidelines from listing page`);
    for (const g of discovered) {
      discoveredUrls.add(g.url);
    }
  } else {
    console.warn("  Failed to fetch guideline listing page");
    counters.fetchErrors++;
  }

  // Step 2: Merge with curated list (curated URLs take priority for type info)
  for (const known of KNOWN_GUIDELINES) {
    discoveredUrls.add(known.url);
  }

  console.log(`  Total guideline URLs to process: ${discoveredUrls.size}`);
  counters.guidelinesFound = discoveredUrls.size;

  // Step 3: Fetch and parse each guideline detail page
  const insertGuideline = db.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const url of discoveredUrls) {
    const reference = referenceFromSlug(url);

    if (FLAG_RESUME && existingRefs.has(reference)) {
      counters.guidelinesSkipped++;
      console.log(`  Skipping (already exists): ${reference}`);
      continue;
    }

    // Find type from curated list if available
    const knownSource = KNOWN_GUIDELINES.find((g) => g.url === url);
    const sourceType = knownSource?.type;

    const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
    console.log(`  Fetching guideline: ${fullUrl}`);
    const res = await rateLimitedFetch(fullUrl);
    if (!res) {
      console.warn(`    Failed to fetch: ${fullUrl}`);
      counters.fetchErrors++;
      continue;
    }

    const html = await res.text();
    const parsed = parseGuidelineDetailPage(html, url, sourceType);
    if (!parsed) {
      console.warn(`    Failed to parse guideline at ${fullUrl}`);
      continue;
    }

    if (FLAG_DRY_RUN) {
      console.log(`  [DRY RUN] Would insert guideline: ${parsed.reference} — ${parsed.title.slice(0, 80)}`);
      counters.guidelinesInserted++;
      continue;
    }

    try {
      insertGuideline.run(
        parsed.reference,
        parsed.title,
        parsed.date,
        parsed.type,
        parsed.summary,
        parsed.full_text,
        JSON.stringify(parsed.topics),
        parsed.language,
      );
      counters.guidelinesInserted++;
      console.log(`    Inserted: ${parsed.reference} — ${parsed.title.slice(0, 60)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        counters.guidelinesSkipped++;
        console.log(`    Skipped (duplicate): ${parsed.reference}`);
      } else {
        console.error(`    DB error inserting ${parsed.reference}: ${msg}`);
      }
    }
  }
}

function insertTopics(db: Database.Database): void {
  console.log("\n--- Inserting topics ---");

  const insertTopic = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const insertAll = db.transaction(() => {
    for (const rule of TOPIC_RULES) {
      insertTopic.run(rule.id, rule.name_local, rule.name_en, rule.description);
    }
  });

  if (FLAG_DRY_RUN) {
    console.log(`  [DRY RUN] Would insert ${TOPIC_RULES.length} topics`);
    counters.topicsInserted = TOPIC_RULES.length;
    return;
  }

  insertAll();
  counters.topicsInserted = TOPIC_RULES.length;
  console.log(`  Inserted ${TOPIC_RULES.length} topics`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== AKI (Andmekaitse Inspektsioon) Ingestion Crawler ===");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Rate limit: ${RATE_LIMIT_MS}ms`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`Flags: ${FLAG_RESUME ? "--resume " : ""}${FLAG_DRY_RUN ? "--dry-run " : ""}${FLAG_FORCE ? "--force " : ""}`.trim() || "Flags: (none)");
  console.log("");

  const db = FLAG_DRY_RUN ? null : initDb();
  const existingRefs = db && FLAG_RESUME ? getExistingReferences(db) : new Set<string>();

  if (FLAG_RESUME && existingRefs.size > 0) {
    console.log(`Resume mode: ${existingRefs.size} existing references will be skipped`);
  }

  // For dry-run, create a temporary in-memory DB to validate schema
  const workDb = db ?? (() => {
    const memDb = new Database(":memory:");
    memDb.pragma("journal_mode = WAL");
    memDb.pragma("foreign_keys = ON");
    memDb.exec(SCHEMA_SQL);
    return memDb;
  })();

  try {
    // 1. Insert topic vocabulary
    insertTopics(workDb);

    // 2. Ingest decisions (ettekirjutused + otsused)
    await ingestDecisions(workDb, existingRefs);

    // 3. Ingest guidelines (juhendid)
    await ingestGuidelines(workDb, existingRefs);

    // Summary
    console.log("\n=== Ingestion Summary ===");
    console.log(`  Topics inserted:      ${counters.topicsInserted}`);
    console.log(`  Decisions found:      ${counters.decisionsFound}`);
    console.log(`  Decisions inserted:   ${counters.decisionsInserted}`);
    console.log(`  Decisions skipped:    ${counters.decisionsSkipped}`);
    console.log(`  Guidelines found:     ${counters.guidelinesFound}`);
    console.log(`  Guidelines inserted:  ${counters.guidelinesInserted}`);
    console.log(`  Guidelines skipped:   ${counters.guidelinesSkipped}`);
    console.log(`  Fetch errors:         ${counters.fetchErrors}`);

    if (!FLAG_DRY_RUN && db) {
      const dc = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
      const gc = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
      const tc = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
      console.log(`\n  Database totals:`);
      console.log(`    Topics:     ${tc}`);
      console.log(`    Decisions:  ${dc}`);
      console.log(`    Guidelines: ${gc}`);
    }

    if (FLAG_DRY_RUN) {
      console.log("\n  (Dry run — no data was written to disk)");
    }
  } finally {
    workDb.close();
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
