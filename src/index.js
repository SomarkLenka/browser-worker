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
        let html, options;

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
            const body = JSON.parse(rawBody);
            console.log('Received JSON body with keys:', Object.keys(body));

            // Support both { html: "..." } and { url: "data:text/html..." } formats
            if (body.html) {
              html = body.html;
            } else if (body.url) {
              // Handle data URL format
              if (body.url.startsWith('data:text/html;base64,')) {
                const base64Data = body.url.slice('data:text/html;base64,'.length);
                html = atob(base64Data);
                console.log('Decoded HTML from base64 data URL');
              } else if (body.url.startsWith('data:text/html,')) {
                html = decodeURIComponent(body.url.slice('data:text/html,'.length));
                console.log('Decoded HTML from data URL');
              } else {
                throw new Error('Unsupported URL format. Only data URLs are supported.');
              }
            }

            options = body.options || {};
          } catch (parseError) {
            console.error('JSON parse error:', parseError);
            throw new Error('Invalid JSON in request body');
          }
        } else {
          html = rawBody;
          options = {};
        }

        console.log('HTML length:', html?.length || 0);

        if (!html) {
          throw new Error('No HTML content provided. Expected { html: string, options?: object } or { url: "data:text/html..." }');
        }

        // Verify browser binding exists
        if (!env.BROWSER) {
          throw new Error('Browser binding not configured. Check wrangler.jsonc browser.binding setting.');
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
