module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { storyId, scenes, storyLevel, maxRetries } = req.body || {};
  if (!storyId || !Array.isArray(scenes) || !scenes.length) {
    return res.status(400).json({ error: 'storyId and scenes[] are required' });
  }

  const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
  const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
  if (!OPENAI_API_KEY)    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const retries = typeof maxRetries === 'number' ? maxRetries : 3;
  const results = [];

  for (const scene of scenes) {
    const { id: sceneId, imagePrompt, sceneText, characterDescriptions } = scene;
    let attempts = 0;
    let approved = false;
    let imageBase64 = null;
    let scores = null;

    while (attempts < retries && !approved) {
      attempts++;

      // ── 1. Générer l'image ─────────────────────────────────────────────────
      try {
        const genResp = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + OPENAI_API_KEY
          },
          body: JSON.stringify({
            model: 'gpt-image-1',
            prompt: imagePrompt,
            n: 1,
            size: '1536x1024',
            quality: 'medium'
          })
        });
        const genData = await genResp.json();
        if (!genResp.ok) throw new Error(genData.error && genData.error.message || 'OpenAI error');
        const b64raw = genData.data && genData.data[0] && genData.data[0].b64_json;
        if (!b64raw) throw new Error('No image returned by OpenAI');
        imageBase64 = 'data:image/png;base64,' + b64raw;
      } catch (err) {
        scores = { error: err.message };
        break;
      }

      // ── 2. Valider avec Claude ─────────────────────────────────────────────
      try {
        const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
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

        const valResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: 'You are a quality checker for a children\'s illustrated storybook app. You analyze AI-generated illustrations and rate their quality on specific criteria. Always respond with valid JSON only, no other text.',
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
                { type: 'text', text: userPrompt }
              ]
            }]
          })
        });

        const valData = await valResp.json();
        if (!valResp.ok) throw new Error(valData.error && valData.error.message || 'Anthropic error');

        const rawText = valData.content && valData.content[0] && valData.content[0].text;
        const cleaned = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        scores = JSON.parse(cleaned);
        approved = !!scores.approved;

      } catch (err) {
        scores = { error: err.message, approved: false };
        approved = false;
      }
    }

    results.push({
      sceneId,
      imageBase64,
      approved,
      needsReview: !approved,
      scores,
      attempts
    });
  }

  return res.status(200).json(results);
};

module.exports.config = { maxDuration: 300 };
