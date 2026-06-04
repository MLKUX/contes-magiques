const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  try {
    const body = JSON.stringify({
      model: 'dall-e-3',
      prompt: prompt + ', children book illustration style, Pixar 3D animation style, vibrant colors, safe for kids, no text in image',
      n: 1,
      size: '1792x1024',
      quality: 'standard'
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const data = await new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch(e) { reject(new Error('Invalid JSON')); }
        });
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });

    if (data.error) return res.status(500).json({ error: data.error.message });
    return res.status(200).json({ url: data.data[0].url });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
