import puppeteer from '@cloudflare/puppeteer';

/**
 *  Browser-Rendering Worker
 *  – one public GET / for health
 *  – one RPC method htmlToPdf() that other Workers call via service binding
 */
export default {
  /* required so the script has an entry point */
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/') {
      return new Response(
        'browser-render online ✅\n' +
        'POST body = <html> → /pdf to get a PDF',
        { headers: { 'content-type': 'text/plain' } }
      );
    }

    // Handle direct POST requests for PDF generation
    if (request.method === 'POST' && new URL(request.url).pathname === '/pdf') {
      let html, options;

      // Check if body is JSON or plain HTML
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const body = await request.json();
        html = body.html;
        options = body.options || {};
      } else {
        html = await request.text();
        options = {};
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
    }

    return new Response('Not Found', { status: 404 });
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
