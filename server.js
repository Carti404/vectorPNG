const http = require('http');
const https = require('https');
const { Jimp } = require('jimp');
const potrace = require('potrace');

const PORT = 3456;

// Helper to write JSON error responses
function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// Tracing pipeline
async function traceColorImage(imageBuffer, maxColors, style) {
  const image = await Jimp.read(imageBuffer);
  
  let width = image.bitmap.width;
  let height = image.bitmap.height;
  
  const maxDimension = 512;
  if (width > maxDimension || height > maxDimension) {
    if (width > height) {
      height = Math.round((height * maxDimension) / width);
      width = maxDimension;
    } else {
      width = Math.round((width * maxDimension) / height);
      height = maxDimension;
    }
    image.resize({ w: width, h: height });
  }

  // Determine turdsize and alphamax based on style
  let turdsize = 10;
  let alphamax = 1.0;
  if (style === 'clean') {
    turdsize = 25;
    alphamax = 1.3;
  } else if (style === 'detailed') {
    turdsize = 3;
    alphamax = 0.8;
  } else if (style === 'logo' || style === 'flat') {
    turdsize = 12;
    alphamax = 1.0;
  }
  
  // Count colors
  const colorCounts = {};
  image.scan(0, 0, width, height, function(x, y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    
    if (a < 50) return; // transparent
    
    const qr = Math.round(r / 16) * 16;
    const qg = Math.round(g / 16) * 16;
    const qb = Math.round(b / 16) * 16;
    const key = `${qr},${qg},${qb}`;
    colorCounts[key] = (colorCounts[key] || 0) + 1;
  });
  
  const dominantColors = Object.keys(colorCounts)
    .map(key => {
      const [r, g, b] = key.split(',').map(Number);
      return { r, g, b, count: colorCounts[key] };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors);
    
  if (dominantColors.length === 0) {
    dominantColors.push({ r: 0, g: 0, b: 0, count: 1 });
  }
  
  const paths = [];
  
  for (let i = 0; i < dominantColors.length; i++) {
    const target = dominantColors[i];
    const mask = new Jimp({ width, height, color: 0xFFFFFFFF });
    
    image.scan(0, 0, width, height, function(x, y, idx) {
      const r = this.bitmap.data[idx];
      const g = this.bitmap.data[idx + 1];
      const b = this.bitmap.data[idx + 2];
      const a = this.bitmap.data[idx + 3];
      
      if (a < 50) return;
      
      let minDistance = Infinity;
      let closestIndex = -1;
      for (let j = 0; j < dominantColors.length; j++) {
        const c = dominantColors[j];
        const dist = Math.pow(r - c.r, 2) + Math.pow(g - c.g, 2) + Math.pow(b - c.b, 2);
        if (dist < minDistance) {
          minDistance = dist;
          closestIndex = j;
        }
      }
      if (closestIndex === i) {
        mask.setPixelColor(0x000000FF, x, y);
      }
    });
    
    const maskBuffer = await mask.getBuffer('image/png');
    const draftHex = '#' + [target.r, target.g, target.b]
      .map(v => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0'))
      .join('');
      
    await new Promise((resolve) => {
      potrace.trace(maskBuffer, { turdsize, alphamax, color: draftHex, background: 'transparent' }, (err, svg) => {
        if (err) {
          console.error(err);
          return resolve();
        }
        
        const pathRegex = /<path([^>]+)>/g;
        let match;
        let pathIndex = 0;
        while ((match = pathRegex.exec(svg)) !== null) {
          const pathAttrString = match[1];
          const dMatch = pathAttrString.match(/d="([^"]+)"/);
          if (!dMatch) continue;
          const d = dMatch[1];
          const pathId = `path_${i}_${pathIndex++}`;
          
          const coords = d.match(/-?\d+(\.\d+)?/g);
          let bbox = null;
          let center = null;
          if (coords) {
            const numCoords = coords.map(Number);
            const xs = [];
            const ys = [];
            for (let k = 0; k < numCoords.length; k += 2) {
              if (k < numCoords.length) xs.push(numCoords[k]);
              if (k + 1 < numCoords.length) ys.push(numCoords[k+1]);
            }
            if (xs.length > 0 && ys.length > 0) {
              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const minY = Math.min(...ys);
              const maxY = Math.max(...ys);
              const w = maxX - minX;
              const h = maxY - minY;
              bbox = [minX, minY, w, h];
              center = [minX + w / 2, minY + h / 2];
            }
          }
          
          paths.push({
            id: pathId,
            d,
            bbox,
            center,
            draftColor: draftHex,
            color: draftHex
          });
        }
        resolve();
      });
    });
  }
  
  return { width, height, paths };
}

// Call vision model
function callNvidiaVisionModel(apiKey, model, base64Image, mimeType, prompt) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: model,
      max_tokens: 1500,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` }
          },
          { type: 'text', text: prompt }
        ]
      }]
    };

    const postData = JSON.stringify(payload);
    const options = {
      hostname: 'integrate.api.nvidia.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const nvidiaReq = https.request(options, nvidiaRes => {
      let data = '';
      nvidiaRes.on('data', chunk => data += chunk);
      nvidiaRes.on('end', () => {
        if (nvidiaRes.statusCode < 200 || nvidiaRes.statusCode >= 300) {
          return reject(new Error(`NVIDIA API HTTP ${nvidiaRes.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Invalid JSON response from NVIDIA API: ${data}`));
        }
      });
    });

    nvidiaReq.on('error', err => reject(err));
    nvidiaReq.write(postData);
    nvidiaReq.end();
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Legacy Proxy endpoint
  if (req.method === 'POST' && req.url === '/proxy') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return sendError(res, 400, 'Bad JSON'); }

      const { apiKey, payload } = parsed;
      if (!apiKey || !payload) return sendError(res, 400, 'Faltan apiKey o payload');

      const postData = JSON.stringify(payload);
      const options = {
        hostname: 'integrate.api.nvidia.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const nvidiaReq = https.request(options, nvidiaRes => {
        let data = '';
        nvidiaRes.on('data', chunk => data += chunk);
        nvidiaRes.on('end', () => {
          res.writeHead(nvidiaRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      nvidiaReq.on('error', err => sendError(res, 502, err.message));
      nvidiaReq.write(postData);
      nvidiaReq.end();
    });
    return;
  }

  // New atomic /vectorize endpoint
  if (req.method === 'POST' && req.url === '/vectorize') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return sendError(res, 400, 'Bad JSON'); }

      const { apiKey, image, mimeType, maxColors, model, style } = parsed;
      if (!apiKey || !image || !mimeType) {
        return sendError(res, 400, 'Faltan parámetros obligatorios (apiKey, image, mimeType)');
      }

      const colorsLimit = parseInt(maxColors) || 6;
      const targetModel = model || 'qwen/qwen3.5-397b-a17b';

      try {
        const imageBuffer = Buffer.from(image, 'base64');
        console.log(`[Vectorize] Decoded image buffer size: ${imageBuffer.length} bytes`);
        
        console.log(`[Vectorize] Starting Potrace color separation (maxColors: ${colorsLimit}, style: ${style})...`);
        const { width, height, paths } = await traceColorImage(imageBuffer, colorsLimit, style);
        console.log(`[Vectorize] Extracted ${paths.length} vector paths.`);

        if (paths.length === 0) {
          const emptySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"></svg>`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ svg: emptySvg }));
        }

        // Prepare info for vision model prompt
        const pathsInfo = paths.map(p => ({
          id: p.id,
          center: p.center ? [Math.round(p.center[0]), Math.round(p.center[1])] : null,
          bbox: p.bbox ? [Math.round(p.bbox[0]), Math.round(p.bbox[1]), Math.round(p.bbox[2]), Math.round(p.bbox[3])] : null,
          draftColor: p.draftColor
        }));

        const prompt = `You are a professional image vectorization colorist. We have analyzed the uploaded image and extracted vector paths using Potrace.
Each path represents a specific shape or region in the image.
We have calculated the center point [cx, cy] (relative to the image size of ${width}x${height} pixels) and the bounding box [x, y, width, height] for each path, along with a draft/initial color.

Your task:
1. Match each path ID to its corresponding semantic element in the original image.
2. Determine the exact, clean, professional color (in HEX format like #RRGGBB) of that element in the original image. Ignore anti-aliasing noise, shadows, or artifacts. Use pure brand/object colors.
3. For transparent or background regions, if they should be transparent, you can return "transparent".
4. You must output ONLY a raw JSON object mapping each path ID to its final HEX color. Do NOT include markdown fences, code block markers, or any explanations.

Example output format:
{
  "path_0_0": "#FF0000",
  "path_1_0": "#FFFFFF",
  "path_2_1": "transparent"
}

Here are the paths to color:
${JSON.stringify(pathsInfo, null, 2)}`;

        console.log(`[Vectorize] Querying vision model ${targetModel} for path coloring...`);
        let nvidiaRes;
        try {
          nvidiaRes = await callNvidiaVisionModel(apiKey, targetModel, image, mimeType, prompt);
        } catch (nvidiaErr) {
          console.error(`[Vectorize] NVIDIA API Error: ${nvidiaErr.message}. Falling back to draft colors.`);
        }

        let colorMapping = {};
        if (nvidiaRes && nvidiaRes.choices && nvidiaRes.choices[0] && nvidiaRes.choices[0].message) {
          let content = nvidiaRes.choices[0].message.content.trim();
          console.log(`[Vectorize] Model raw output:\n${content}`);

          // Strip markdown code fences if any
          content = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

          try {
            colorMapping = JSON.parse(content);
            console.log(`[Vectorize] Parsed color mapping successfully.`);
          } catch (jsonErr) {
            console.error('[Vectorize] Failed to parse model output as JSON. Falling back to draft colors.', jsonErr.message || String(jsonErr));
          }
        }

        // Apply colors from model mapping
        paths.forEach(p => {
          if (colorMapping[p.id]) {
            const mappedColor = colorMapping[p.id].trim();
            // Validate HEX color format or 'transparent'
            if (/^(#[0-9A-F]{6}|transparent)$/i.test(mappedColor)) {
              p.color = mappedColor;
            }
          }
        });

        // Generate combined SVG
        const svgPaths = paths.map(p => {
          if (style === 'outline') {
            return `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
          } else {
            return `<path d="${p.d}" fill="${p.color}" stroke="none" fill-rule="evenodd" />`;
          }
        });
        const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  ${svgPaths.join('\n  ')}
</svg>`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ svg: finalSvg }));

      } catch (err) {
        const errMsg = err && (err.stack || err.message || String(err));
        console.error('[Vectorize] Error:', errMsg);
        return sendError(res, 500, err && (err.message || String(err)));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✅ Proxy & Vectorizer corriendo en http://localhost:${PORT}`);
  console.log(`   Abre vectorizador-nvidia.html en tu navegador`);
  console.log(`   Ctrl+C para detener`);
});
