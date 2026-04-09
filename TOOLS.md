# Tool Reference

All tools use the prefix `ee_dp_`. Responses include a `_meta` block with disclaimer, source URL, copyright, and tool name.

## ee_dp_search_decisions

Full-text search across AKI decisions and sanctions.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g., `küpsised`, `andmeleke`) |
| `type` | string | no | Filter: `sanction`, `warning`, `reprimand`, `decision` |
| `topic` | string | no | Filter by topic ID (see `ee_dp_list_topics`) |
| `limit` | number | no | Max results (default 20, max 100) |

**Response:** `{ results: Decision[], count: number, _meta }`

---

## ee_dp_get_decision

Get a specific AKI decision by reference number. Includes `_citation` block for entity linking.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `reference` | string | yes | AKI case reference (e.g., `AKI-2022-001`) |

**Response:** Decision object with `_citation` and `_meta` blocks.

---

## ee_dp_search_guidelines

Full-text search across AKI guidance documents.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g., `DPIA`, `andmesubjekti õigused`) |
| `type` | string | no | Filter: `guide`, `recommendation`, `faq`, `template` |
| `topic` | string | no | Filter by topic ID |
| `limit` | number | no | Max results (default 20, max 100) |

**Response:** `{ results: Guideline[], count: number, _meta }`

---

## ee_dp_get_guideline

Get a specific AKI guidance document by database ID. Includes `_citation` block.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | number | yes | Guideline database ID (from search results) |

**Response:** Guideline object with `_citation` and `_meta` blocks.

---

## ee_dp_list_topics

List all data protection topics in the controlled vocabulary.

**Arguments:** none

**Response:** `{ topics: Topic[], count: number, _meta }`

Each topic: `{ id, name_local, name_en, description }`

---

## ee_dp_list_sources

List data sources with record counts and newest record dates.

**Arguments:** none

**Response:**
```json
{
  "sources": [
    {
      "id": "decisions",
      "label": "AKI Decisions and Sanctions",
      "authority": "AKI (Andmekaitse Inspektsioon)",
      "url": "https://www.aki.ee/ettekirjutused",
      "record_count": 42,
      "newest_record": "2024-11-15"
    },
    {
      "id": "guidelines",
      "label": "AKI Guidance Documents",
      "authority": "AKI (Andmekaitse Inspektsioon)",
      "url": "https://www.aki.ee/kiirelt-katte/juhendid",
      "record_count": 18,
      "newest_record": "2024-10-03"
    }
  ],
  "_meta": { ... }
}
```

---

## ee_dp_check_data_freshness

Check database recency: record counts and newest dates per dataset.

**Arguments:** none

**Response:**
```json
{
  "decisions_newest": "2024-11-15",
  "decisions_count": 42,
  "guidelines_newest": "2024-10-03",
  "guidelines_count": 18,
  "_meta": { ... }
}
```

---

## ee_dp_about

Return server metadata: name, version, data source, coverage summary, and tool list.

**Arguments:** none

**Response:** `{ name, version, description, data_source, coverage, tools[], _meta }`

---

## Common Response Fields

### `_meta` block (all responses)

```json
{
  "_meta": {
    "disclaimer": "This is not legal advice. Verify all information with official AKI sources.",
    "source_url": "https://www.aki.ee/",
    "copyright": "AKI (Andmekaitse Inspektsioon)",
    "tool": "ee_dp_<tool_name>"
  }
}
```

### `_citation` block (`get_decision`, `get_guideline`)

```json
{
  "_citation": {
    "canonical_ref": "AKI-2022-001",
    "display_text": "AKI decision AKI-2022-001",
    "source_url": "https://www.aki.ee/...",
    "lookup": {
      "tool": "ee_dp_get_decision",
      "args": { "reference": "AKI-2022-001" }
    }
  }
}
```
