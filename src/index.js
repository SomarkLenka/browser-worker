import puppeteer from '@cloudflare/puppeteer';

/**
 *  Browser-Rendering Worker
 *  – one public GET / for health
 *  – one RPC method htmlToPdf() that other Workers call via service binding
 */
export default {
  /* required so the script has an entry point */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    console.log(`Received ${request.method} request to ${pathname}`);

    // Handle PDF generation requests (both / and /pdf paths)
    if (request.method === 'POST' && (pathname === '/' || pathname === '/pdf')) {
      try {
        let requestBody;

        // Clone request to read body multiple times if needed
        const clonedRequest = request.clone();

        // Try to get raw body first for debugging
        const rawBody = await clonedRequest.text();
        console.log('Raw body length:', rawBody.length);
        console.log('Raw body preview:', rawBody.substring(0, 200));

        // Check if body is JSON or plain HTML
        const contentType = request.headers.get('content-type') || '';
        console.log('Content-Type:', contentType);

        if (contentType.includes('application/json')) {
          try {
            requestBody = JSON.parse(rawBody);
            console.log('Received JSON body with keys:', Object.keys(requestBody));
          } catch (parseError) {
            console.error('JSON parse error:', parseError);
            throw new Error('Invalid JSON in request body');
          }
        } else {
          // Plain HTML string - treat as single mode
          requestBody = { html: rawBody };
        }

        // Verify browser binding exists
        if (!env.BROWSER) {
          throw new Error('Browser binding not configured. Check wrangler.jsonc browser.binding setting.');
        }

        // BATCH MODE
        if (requestBody.batch && Array.isArray(requestBody.batch)) {
          console.log(`Processing batch of ${requestBody.batch.length} items`);
          return await this.processBatch(requestBody.batch, requestBody.concurrency || 3, env);
        }

        // SINGLE MODE (backward compatibility)
        const html = requestBody.html;
        const options = requestBody.options || {};

        console.log('HTML length:', html?.length || 0);

        if (!html) {
          throw new Error('No HTML content provided. Expected { html: string, options?: object } or { batch: [...], concurrency?: number }');
        }

        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({
          format: options.format || 'A4',
          printBackground: options.printBackground !== false,
          margin: options.margin || { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
        });

        await browser.close();

        return new Response(pdf, {
          headers: { 'content-type': 'application/pdf' }
        });
      } catch (error) {
        console.error('PDF generation error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    }

    // Health check for GET /
    if (request.method === 'GET' && pathname === '/') {
      return new Response(
        'browser-render online ✅\n' +
        'POST body = <html> → / or /pdf to get a PDF',
        { headers: { 'content-type': 'text/plain' } }
      );
    }

    console.log(`No route matched for ${request.method} ${pathname}`);
    return new Response(`Not Found: ${request.method} ${pathname}`, { status: 404 });
  },

  /**
   * Process batch of HTML to PDF conversions with controlled concurrency
   * @param {Array} batch - Array of { id, html, options } objects
   * @param {number} concurrency - Max concurrent browser sessions (default: 3)
   * @param {Object} env - Environment bindings
   * @returns {Response} JSON response with results array
   */
  async processBatch(batch, concurrency, env) {
    // Validate batch items
    for (const item of batch) {
      if (!item.html) {
        throw new Error(`Batch item missing html property: ${JSON.stringify(item)}`);
      }
      if (!item.id) {
        throw new Error(`Batch item missing id property: ${JSON.stringify(item)}`);
      }
    }

    // Cap concurrency at 3 browsers max
    const maxConcurrency = Math.min(concurrency, 3);
    console.log(`Batch processing ${batch.length} items with ${maxConcurrency} concurrent browsers`);

    // Distribute items across browser sessions in round-robin fashion
    // For 7 items with concurrency=3: [[1,4,7], [2,5], [3,6]]
    const chunks = Array.from({ length: maxConcurrency }, () => []);
    batch.forEach((item, index) => {
      chunks[index % maxConcurrency].push(item);
    });

    // Filter out empty chunks
    const nonEmptyChunks = chunks.filter(chunk => chunk.length > 0);
    console.log(`Distributed ${batch.length} items across ${nonEmptyChunks.length} browsers: ${nonEmptyChunks.map(c => c.length).join(', ')} items each`);

    try {
      // Process each chunk in parallel (each chunk = one browser session)
      const allResults = await Promise.all(
        nonEmptyChunks.map(async (chunk, chunkIndex) => {
          console.log(`Browser ${chunkIndex + 1}/${nonEmptyChunks.length} processing ${chunk.length} items: ${chunk.map(c => c.id).join(', ')}`);

          let browser;
          try {
            browser = await puppeteer.launch(env.BROWSER);

            // Within this browser session, process items sequentially
            const chunkResults = [];
            for (const item of chunk) {
              try {
                const page = await browser.newPage();
                await page.setContent(item.html, { waitUntil: 'networkidle0' });

                const pdfOptions = {
                  format: item.options?.format || 'A4',
                  printBackground: item.options?.printBackground !== false,
                  margin: item.options?.margin || { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
                };

                const pdf = await page.pdf(pdfOptions);

                chunkResults.push({
                  id: item.id,
                  success: true,
                  pdf: Buffer.from(pdf).toString('base64')
                });

                await page.close();
                console.log(`Successfully processed item ${item.id}`);
              } catch (itemError) {
                console.error(`Error processing item ${item.id}:`, itemError);
                chunkResults.push({
                  id: item.id,
                  success: false,
                  error: itemError.message
                });
              }
            }

            return chunkResults;
          } finally {
            if (browser) {
              await browser.close();
              console.log(`Browser ${chunkIndex + 1} closed`);
            }
          }
        })
      );

      // Flatten results from all browser sessions
      const results = allResults.flat();
      console.log(`Batch complete. Processed ${results.length} items`);

      return new Response(JSON.stringify({
        results,
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      }), {
        headers: { 'content-type': 'application/json' }
      });
    } catch (error) {
      console.error('Batch processing error:', error);
      throw error;
    }
  },

  /**
   * Called from another Worker via
   *    const pdfBuf = await env.BROWSER.htmlToPdf({ body: html, cf: { format: "A4" } });
   */
  async htmlToPdf(request, env, ctx) {
    // request is an object with body (HTML string) and cf (options)
    const html = request.body || request;  // support both formats
    const options = request.cf || { format: 'A4' };

    let browser;
    try {
      // Launch browser using Cloudflare Puppeteer
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();

      // Set the HTML content
      await page.setContent(html, { waitUntil: 'networkidle0' });

      // Generate PDF with options
      const pdf = await page.pdf({
        format: options.format || 'A4',
        printBackground: true,
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
      });

      return pdf;
    } catch (error) {
      console.error('PDF generation error:', error);
      throw error;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.error('Error closing browser:', closeError);
        }
      }
    }
  }
}
