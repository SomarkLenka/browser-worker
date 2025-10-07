# Batch Processing Documentation

## Overview

The browser-worker now supports hybrid batch processing with controlled concurrency. This allows you to process multiple HTML to PDF conversions efficiently by spawning up to 3 concurrent browser sessions.

## Architecture

### Strategy
- **Single Activity (1 item)**: Direct single call
- **Small Batch (2-4 items)**: Single batch call, sequential processing in one browser session
- **Large Batch (5+ items)**: Multiple browser sessions with staggered launches

### Implementation Details
- **Rate Limits (Cloudflare Workers Browser Binding)**:
  - Maximum concurrent browsers: **3 per account**
  - Maximum new browsers: **3 per minute**
  - Browser timeout: **60 seconds** (can extend to 10 minutes with keep_alive)

- **Our Approach**:
  - Default concurrency: **2 browsers** (leaves room for retries)
  - Staggered browser launches: **22 second delay** between launches
  - Retry logic with exponential backoff for rate limit errors
  - Multiple PDFs generated per browser session using tabs (efficient reuse)

- Each item in a batch must have a unique `id` for tracking
- Robust error handling per item (one failure doesn't stop the batch)
- Browser sessions are reused for multiple PDFs to optimize performance

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
Items are distributed across browser sessions using round-robin distribution. Browsers launch sequentially with delays to respect rate limits (3 browsers/minute). Each browser processes multiple items using separate tabs.

### Example: 7 Items with Concurrency=2 (Default)
```
Browser 1: Items [1, 3, 5, 7] - processes sequentially in tabs
  └─ Launch: 0s
Browser 2: Items [2, 4, 6]    - processes sequentially in tabs
  └─ Launch: 22s (after 22 second delay)
```
**Total time**: ~22 seconds + processing time for all PDFs

### Example: 10 Items with Concurrency=2
```
Browser 1: Items [1, 3, 5, 7, 9]  - 5 PDFs sequentially
  └─ Launch: 0s
Browser 2: Items [2, 4, 6, 8, 10] - 5 PDFs sequentially
  └─ Launch: 22s (after 22 second delay)
```

### Rate Limit Compliance
- **3 browsers per minute limit**: We launch max 2 browsers with 22s delay = compliant
- **Retry logic**: If rate limit hit, exponential backoff (1s, 2s, 4s delays)
- **Browser reuse**: Each browser generates multiple PDFs using tabs (efficient)

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

## Limitations & Best Practices

### Cloudflare Rate Limits
- **3 concurrent browsers** per account maximum
- **3 new browser launches** per minute
- **60 second timeout** per browser (default)

### Best Practices
- **Batch size**: Recommended 2-20 items per request
- **Large batches**: For 20+ items, consider splitting into multiple requests
- **Timing**: Allow 22+ seconds between browser launches
- **Retries**: Built-in retry logic handles transient rate limit errors

### Cost Considerations
- Browser rendering time counts against Worker CPU time
- Each PDF generation uses browser resources
- Optimize HTML content for faster rendering
