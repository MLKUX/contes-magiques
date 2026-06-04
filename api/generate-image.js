module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const prompt = req.body && req.body.prompt;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt + ', children book illustration, Pixar 3D style, vibrant colors, no text',
        n: 1,
        size: '1792x1024',
        quality: 'standard',
        response_format: 'url'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error && data.error.message || 'OpenAI error' });
    }

    const url = data.data && data.data[0] && data.data[0].url;
    if (!url) return res.status(500).json({ error: 'No URL in response' });

    return res.status(200).json({ url });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
