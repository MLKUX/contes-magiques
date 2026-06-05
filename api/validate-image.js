// ANTHROPIC_API_KEY : ta clé API Anthropic
// À ajouter dans Vercel Dashboard
// → Settings → Environment Variables
// Récupérer sur console.anthropic.com

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, sceneText, storyLevel, characterDescriptions } = req.body || {};
  if (!imageBase64 || !sceneText) {
    return res.status(400).json({ error: 'imageBase64 and sceneText are required' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Strip data URL prefix, keep raw base64
  const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

  const systemPrompt = 'You are a quality checker for a children\'s illustrated storybook app. You analyze AI-generated illustrations and rate their quality on specific criteria. Always respond with valid JSON only, no other text.';

  const userPrompt = `Analyze this illustration for a children's storybook scene.

Scene text: ${sceneText}
Expected characters: ${characterDescriptions || 'not specified'}
Age level: ${storyLevel || 'eveil'}

Rate each criterion from 0 to 10 :

1. style_consistency: Does it look like a children's watercolor picture book (soft colors, simple shapes, gentle textures) ?
2. character_accuracy: Do the characters match their descriptions (right colors, simple rounded shapes, consistent design) ?
3. emotion_match: Does the mood and emotion of the illustration match the scene text ?
4. technical_quality: No visible defects, no extra limbs, no distorted faces, no text artifacts ?
5. age_appropriateness: Is it suitable and appealing for children age 3-5 ?

Also provide :
- approved: true if ALL scores >= 7, false otherwise
- rejection_reason: if approved is false, one short sentence explaining the main problem
- overall_score: average of all 5 scores

Respond ONLY with this JSON format :
{
  "style_consistency": X,
  "character_accuracy": X,
  "emotion_match": X,
  "technical_quality": X,
  "age_appropriateness": X,
  "overall_score": X,
  "approved": true,
  "rejection_reason": ""
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: b64
              }
            },
            {
              type: 'text',
              text: userPrompt
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error && data.error.message || 'Anthropic API error' });
    }

    const rawText = data.content && data.content[0] && data.content[0].text;
    if (!rawText) return res.status(500).json({ error: 'Empty response from Claude' });

    // Strip markdown code fences if present
    const cleaned = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleaned);

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
