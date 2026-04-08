# Data Coverage

This document describes the corpus covered by the Estonian Data Protection MCP server.

## Authority

**AKI — Andmekaitse Inspektsioon (Estonian Data Protection Inspectorate)**
- Website: https://www.aki.ee/
- Jurisdiction: Estonia (EE)
- Mandate: Supervision of GDPR and national data protection law (IKÜS — Isikuandmete kaitse seadus)

## Datasets

### Decisions (`decisions` table)

AKI enforcement decisions, sanctions, warnings, and reprimands issued to controllers and processors.

| Field | Description |
|-------|-------------|
| `reference` | AKI case reference number |
| `title` | Decision title |
| `date` | Decision date (ISO 8601) |
| `type` | `sanction`, `warning`, `reprimand`, or `decision` |
| `entity_name` | Respondent organisation name |
| `fine_amount` | Fine in EUR (null if no fine issued) |
| `gdpr_articles` | JSON array of cited GDPR article numbers |
| `topics` | JSON array of topic IDs |
| `status` | `final` or `appealed` |

**Sources ingested:**
- `https://www.aki.ee/ettekirjutused` — enforcement orders (ettekirjutused)
- `https://www.aki.ee/meist/aki-tegevus/aki-otsused` — appeal decisions (vaidemenetlused)

**Known gaps:**
- Older decisions pre-2019 may be incomplete or missing full text
- Decisions published only in Estonian; no machine translation applied

### Guidelines (`guidelines` table)

AKI guidance documents covering GDPR implementation in Estonia.

| Field | Description |
|-------|-------------|
| `reference` | AKI document reference (if assigned) |
| `title` | Guideline title |
| `date` | Publication date |
| `type` | `guide`, `recommendation`, `faq`, or `template` |
| `language` | Primary language (`et` = Estonian, `en` = English) |
| `topics` | JSON array of topic IDs |

**Sources ingested:**
- `https://www.aki.ee/kiirelt-katte/juhendid` — guidance listing

**Known gaps:**
- Some older guidance documents may lack structured metadata
- English translations available for select documents only

### Topics (`topics` table)

Controlled vocabulary for tagging decisions and guidelines.

| ID | Estonian | English |
|----|----------|---------|
| `cookies` | Küpsised | Cookies |
| `consent` | Nõusolek | Consent |
| `data_breach` | Andmeleke | Data Breach |
| `dpia` | Andmekaitsealane mõjuhinnang | DPIA |
| `employee_monitoring` | Töötajate jälgimine | Employee Monitoring |
| `video_surveillance` | Videovalve | Video Surveillance |
| `data_subject_rights` | Andmesubjekti õigused | Data Subject Rights |
| `international_transfers` | Rahvusvahelised edastamised | International Transfers |

## Update Cadence

The database is populated by the ingestion crawler (`scripts/ingest-aki.ts`). Use `ee_dp_check_data_freshness` to see when records were last updated.

## Disclaimer

Data is sourced from publicly available AKI publications. This MCP server is a research tool — not a substitute for official legal advice. Always verify against the official AKI website.
