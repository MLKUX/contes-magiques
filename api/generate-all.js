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

  const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!OPENAI_API_KEY)    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // ── DEBUG : traiter uniquement la première scène ──────────────────────────
  const scene = scenes[0];
  const { id: sceneId, imagePrompt, sceneText, characterDescriptions } = scene;
  const debugLog = [];

  debugLog.push({ step: 'start', sceneId, imagePrompt: imagePrompt.substring(0, 120) + '…' });

  // ── ÉTAPE 1 : Génération OpenAI ───────────────────────────────────────────
  let imageBase64 = null;
  let openaiRawText = null;
  let openaiStatus = null;

  try {
    debugLog.push({ step: 'openai_fetch_start' });

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

    openaiStatus = genResp.status;
    openaiRawText = await genResp.text();
    debugLog.push({ step: 'openai_response', status: openaiStatus, rawPreview: openaiRawText.substring(0, 300) });

    if (!genResp.ok) {
      return res.status(500).json({
        error: 'OpenAI request failed',
        step: 'openai_generation',
        httpStatus: openaiStatus,
        rawResponse: openaiRawText,
        debugLog
      });
    }

    let genData;
    try {
      genData = JSON.parse(openaiRawText);
    } catch (parseErr) {
      return res.status(500).json({
        error: 'Failed to parse OpenAI JSON',
        step: 'openai_json_parse',
        httpStatus: openaiStatus,
        rawResponse: openaiRawText,
        parseError: parseErr.message,
        debugLog
      });
    }

    debugLog.push({ step: 'openai_parsed', keys: Object.keys(genData), dataLength: genData.data ? genData.data.length : 0 });

    const b64raw = genData.data && genData.data[0] && genData.data[0].b64_json;
    if (!b64raw) {
      return res.status(500).json({
        error: 'No b64_json in OpenAI response',
        step: 'openai_extract_image',
        httpStatus: openaiStatus,
        parsedKeys: Object.keys(genData),
        dataItem: genData.data ? genData.data[0] : null,
        debugLog
      });
    }

    imageBase64 = 'data:image/png;base64,' + b64raw;
    debugLog.push({ step: 'openai_success', imageSizeChars: imageBase64.length });

  } catch (err) {
    return res.status(500).json({
      error: 'Exception during OpenAI fetch: ' + err.message,
      step: 'openai_exception',
      httpStatus: openaiStatus,
      rawResponse: openaiRawText,
      debugLog
    });
  }

  // ── ÉTAPE 2 : Validation Anthropic ────────────────────────────────────────
  let anthropicRawText = null;
  let anthropicStatus = null;
  let scores = null;

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
    debugLog.push({ step: 'anthropic_fetch_start' });

    const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

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

    anthropicStatus = valResp.status;
    anthropicRawText = await valResp.text();
    debugLog.push({ step: 'anthropic_response', status: anthropicStatus, rawPreview: anthropicRawText.substring(0, 500) });

    if (!valResp.ok) {
      return res.status(500).json({
        error: 'Anthropic request failed',
        step: 'anthropic_validation',
        httpStatus: anthropicStatus,
        rawResponse: anthropicRawText,
        debugLog
      });
    }

    let valData;
    try {
      valData = JSON.parse(anthropicRawText);
    } catch (parseErr) {
      return res.status(500).json({
        error: 'Failed to parse Anthropic JSON',
        step: 'anthropic_json_parse',
        httpStatus: anthropicStatus,
        rawResponse: anthropicRawText,
        parseError: parseErr.message,
        debugLog
      });
    }

    debugLog.push({ step: 'anthropic_parsed', contentLength: valData.content ? valData.content.length : 0 });

    const rawText = valData.content && valData.content[0] && valData.content[0].text;
    if (!rawText) {
      return res.status(500).json({
        error: 'No text content in Anthropic response',
        step: 'anthropic_extract_text',
        httpStatus: anthropicStatus,
        parsedKeys: Object.keys(valData),
        content: valData.content,
        debugLog
      });
    }

    debugLog.push({ step: 'anthropic_raw_text', text: rawText });

    let parsedScores;
    try {
      const cleaned = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      parsedScores = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(500).json({
        error: 'Failed to parse Claude scores JSON',
        step: 'scores_json_parse',
        rawClaudeText: rawText,
        parseError: parseErr.message,
        debugLog
      });
    }

    scores = parsedScores;
    debugLog.push({ step: 'anthropic_success', scores });

  } catch (err) {
    return res.status(500).json({
      error: 'Exception during Anthropic fetch: ' + err.message,
      step: 'anthropic_exception',
      httpStatus: anthropicStatus,
      rawResponse: anthropicRawText,
      debugLog
    });
  }

  // ── Résultat final ────────────────────────────────────────────────────────
  return res.status(200).json([{
    sceneId,
    imageBase64,
    approved: !!scores.approved,
    needsReview: !scores.approved,
    scores,
    attempts: 1,
    debugLog
  }]);
};

module.exports.config = { maxDuration: 300 };
