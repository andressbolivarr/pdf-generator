const express = require('express');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const isProduction = process.env.NODE_ENV === 'production';
const puppeteer = isProduction ? require('puppeteer-core') : require('puppeteer');
const chromium = isProduction ? require('@sparticuz/chromium') : null;

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Handlebars Helpers ───────────────────────────────────────────────────────
Handlebars.registerHelper('inc', function(index) {
  return index + 1;
});

// ─── Logo Resolver ────────────────────────────────────────────────────────────
function getLogo(clientSlug) {
  const logosDir = path.join(__dirname, 'logos');
  const extensions = ['png', 'jpg', 'jpeg', 'svg'];

  // Try client-specific logo first, fall back to default
  const candidates = clientSlug
    ? extensions.map(ext => `${clientSlug}.${ext}`)
    : [];
  candidates.push(...extensions.map(ext => `default.${ext}`));

  for (const filename of candidates) {
    const filepath = path.join(logosDir, filename);
    if (fs.existsSync(filepath)) {
      const ext = filename.split('.').pop();
      const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      const data = fs.readFileSync(filepath);
      return `data:${mimeType};base64,${Buffer.from(data).toString('base64')}`;
    }
  }

  return null; // No logo found
}

// ─── PDF Generation ───────────────────────────────────────────────────────────
app.post('/generate-pdf', async (req, res) => {
  try {
    const { template, client, data } = req.body;

    // 1. Load template
    const templatePath = path.join(__dirname, 'templates', `${template}.hbs`);
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: `Template "${template}" not found` });
    }

    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const compiledTemplate = Handlebars.compile(templateSource);

    // 2. Inject logo automatically
    const enrichedData = {
      ...data,
      logo: getLogo(client) // null if not found — template handles gracefully
    };

    const html = compiledTemplate(enrichedData);

    // 3. Launch Puppeteer
    const browser = await puppeteer.launch(
      isProduction
        ? {
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: true,
          }
        : {
            headless: true,
            args: ['--no-sandbox'],
          }
    );

    const page = await browser.newPage();

    // Block external fonts to keep PDF size small
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (
        url.includes('fonts.googleapis.com') ||
        url.includes('fonts.gstatic.com')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // 4. Generate PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });

    await browser.close();

    // 5. Return as base64
    const base64PDF = Buffer.from(pdfBuffer).toString('base64');
    res.json({
      success: true,
      pdf: `data:application/pdf;base64,${base64PDF}`
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ─── List available clients/logos ─────────────────────────────────────────────
app.get('/clients', (req, res) => {
  const logosDir = path.join(__dirname, 'logos');
  if (!fs.existsSync(logosDir)) return res.json({ clients: [] });

  const files = fs.readdirSync(logosDir);
  const clients = files
    .filter(f => /\.(png|jpg|jpeg|svg)$/i.test(f))
    .map(f => f.replace(/\.[^.]+$/, ''))
    .filter(name => name !== 'default');

  res.json({ clients });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF service running on port ${PORT}`));
