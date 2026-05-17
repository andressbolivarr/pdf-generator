const express = require('express');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const isProduction = process.env.NODE_ENV === 'production';
const puppeteer = isProduction ? require('puppeteer-core') : require('puppeteer');
const chromium = isProduction ? require('@sparticuz/chromium') : null;

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/generate-pdf', async (req, res) => {
  try {
    const { template, data } = req.body;

    // 1. Cargar el template correspondiente
    const templatePath = path.join(__dirname, 'templates', `${template}.hbs`);
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: `Template "${template}" not found` });
    }

    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const compiledTemplate = Handlebars.compile(templateSource);
    const html = compiledTemplate(data);

    // 2. Lanzar Puppeteer segun el entorno
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

    // 3. Generar el PDF
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
    });

    await browser.close();

    // 4. Devolver el PDF como base64
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF service running on port ${PORT}`));