# Batch Processing Documentation

## Overview

The browser-worker now supports hybrid batch processing with controlled concurrency. This allows you to process multiple HTML to PDF conversions efficiently by spawning up to 3 concurrent browser sessions.

## Architecture

### Strategy
- **Single Activity (1 item)**: Direct single call
- **Small Batch (2-4 items)**: Single batch call, sequential processing in one browser session
- **Large Batch (5+ items)**: Split into chunks, spawn multiple browser sessions concurrently (max 3)

### Implementation Details
- Maximum concurrent browsers: **3** (hard limit)
- Items are split into chunks and processed in parallel
- Within each browser session, items are processed sequentially
- Each item in a batch must have a unique `id` for tracking
- Robust error handling per item (one failure doesn't stop the batch)

## Request Formats

### Single Mode (Backward Compatible)
```json
{
  "html": "<html><body>Your content</body></html>",
  "options": {
    "format": "A4",
    "printBackground": true,
    "margin": {
      "top": "1cm",
      "right": "1cm",
      "bottom": "1cm",
      "left": "1cm"
    }
  }
}
```

**Response**: PDF binary (application/pdf)

### Batch Mode
```json
{
  "batch": [
    {
      "id": "unique-id-1",
      "html": "<html><body>Document 1</body></html>",
      "options": {
        "format": "A4",
        "printBackground": true
      }
    },
    {
      "id": "unique-id-2",
      "html": "<html><body>Document 2</body></html>",
      "options": {
        "format": "Letter"
      }
    }
  ],
  "concurrency": 3
}
```

**Response**: JSON object with results
```json
{
  "results": [
    {
      "id": "unique-id-1",
      "success": true,
      "pdf": "base64-encoded-pdf-data"
    },
    {
      "id": "unique-id-2",
      "success": true,
      "pdf": "base64-encoded-pdf-data"
    }
  ],
  "total": 2,
  "successful": 2,
  "failed": 0
}
```

## Batch Item Schema
Each item in the `batch` array must have:
- `id` (required): Unique identifier for tracking
- `html` (required): HTML content string
- `options` (optional): PDF generation options
  - `format`: "A4", "Letter", etc. (default: "A4")
  - `printBackground`: boolean (default: true)
  - `margin`: object with top/right/bottom/left

## Example Usage

### Using curl
```bash
# Single mode
curl -X POST http://localhost:8787/pdf \
  -H "Content-Type: application/json" \
  -d '{"html":"<html><body><h1>Test</h1></body></html>"}' \
  --output single.pdf

# Batch mode
curl -X POST http://localhost:8787/pdf \
  -H "Content-Type: application/json" \
  -d @test-batch.json \
  --output batch-results.json
```

### Processing Batch Results
```javascript
const response = await fetch('http://localhost:8787/pdf', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    batch: [
      { id: '1', html: '<html>...</html>' },
      { id: '2', html: '<html>...</html>' }
    ],
    concurrency: 3
  })
});

const { results } = await response.json();

results.forEach(result => {
  if (result.success) {
    // Decode base64 PDF
    const pdfBuffer = Buffer.from(result.pdf, 'base64');
    // Save or process PDF
  } else {
    console.error(`Failed to process ${result.id}:`, result.error);
  }
});
```

## Performance Characteristics

### Concurrency Model
Items are distributed across browser sessions using round-robin distribution. All browsers run in parallel, processing their assigned items sequentially.

### Example: 7 Items with Concurrency=3
```
Browser 1: Items [1, 4, 7] - processes sequentially
Browser 2: Items [2, 5]    - processes sequentially
Browser 3: Items [3, 6]    - processes sequentially
```
All 3 browsers run **concurrently**, but each browser processes its items **sequentially**.

### Example: 10 Items with Concurrency=3
```
Browser 1: Items [1, 4, 7, 10] - 4 items sequentially
Browser 2: Items [2, 5, 8]     - 3 items sequentially
Browser 3: Items [3, 6, 9]     - 3 items sequentially
```
All 3 browsers run in parallel simultaneously.

## Error Handling
- Individual item failures don't stop batch processing
- Failed items return `{ success: false, error: "message" }`
- Successful items return `{ success: true, pdf: "base64..." }`
- Response includes summary: `total`, `successful`, `failed`

## Validation
The worker validates:
- Each batch item has required `id` field
- Each batch item has required `html` field
- Concurrency is capped at 3 (even if higher value is requested)

## Limitations
- Maximum concurrent browsers: 3 (Cloudflare Workers constraint)
- Browser sessions have timeout limits (check Cloudflare docs)
- Memory limits apply per Worker invocation
- Recommended batch size: 10-50 items per request
