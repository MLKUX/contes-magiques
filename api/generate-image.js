export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt + ', children book illustration style, Pixar 3D animation style, vibrant colors, safe for kids, no text in image',
        n: 1,
        size: '1792x1024',
        quality: 'standard'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'OpenAI error' });
    }

    return res.status(200).json({ url: data.data[0].url });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
