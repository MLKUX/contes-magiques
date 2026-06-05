// GITHUB_TOKEN : créer sur github.com/settings/tokens
// avec droits "repo" (full control)
// GITHUB_REPO : "MLKUX/contes-magiques"
// Ajouter ces deux variables dans Vercel Dashboard
// → Settings → Environment Variables

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { storyId, sceneId, imageBase64 } = req.body || {};
  if (!storyId || !sceneId || !imageBase64) {
    return res.status(400).json({ error: 'storyId, sceneId and imageBase64 are required' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN or GITHUB_REPO not configured' });
  }

  const API = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';
  const headers = {
    'Authorization': 'Bearer ' + GITHUB_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Récupérer le fichier depuis GitHub
    const getRes = await fetch(API, { headers });
    if (!getRes.ok) {
      const err = await getRes.json();
      return res.status(500).json({ error: 'GitHub GET failed: ' + (err.message || getRes.status) });
    }
    const fileData = await getRes.json();
    const sha = fileData.sha;
    const content = Buffer.from(fileData.content, 'base64').toString('utf8');

    // 2. Trouver la scène et remplacer cachedImage
    // On cherche le bloc de la scène identifiée par id:'<sceneId>' dans l'histoire '<storyId>'
    // Le pattern ciblé est : cachedImage:"" (vide) dans le contexte de cette scène
    // Stratégie : remplacer la première occurrence de cachedImage:"" après id:'<sceneId>'
    const sceneMarker = "id:'" + sceneId + "'";
    const sceneIdx = content.indexOf(sceneMarker);
    if (sceneIdx === -1) {
      // Essayer aussi avec id:"sceneId" au cas où
      return res.status(404).json({ error: 'Scene not found: ' + storyId + '/' + sceneId });
    }

    // Chercher la prochaine occurrence de cachedImage:"" après la scène
    const searchFrom = sceneIdx;
    const oldCached = 'cachedImage:""';
    const cachedIdx = content.indexOf(oldCached, searchFrom);
    if (cachedIdx === -1) {
      return res.status(404).json({ error: 'cachedImage field not found for scene ' + sceneId });
    }

    // Vérifier qu'on ne dépasse pas la scène suivante
    const nextSceneIdx = content.indexOf("id:'", sceneIdx + sceneMarker.length);
    if (nextSceneIdx !== -1 && cachedIdx > nextSceneIdx) {
      return res.status(404).json({ error: 'cachedImage not in expected scene ' + sceneId });
    }

    const newContent = content.substring(0, cachedIdx) +
      'cachedImage:"' + imageBase64 + '"' +
      content.substring(cachedIdx + oldCached.length);

    // 3. Commit via l'API GitHub
    const putBody = JSON.stringify({
      message: 'cache: ' + storyId + '/' + sceneId + ' image validated',
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha: sha
    });

    const putRes = await fetch(API, { method: 'PUT', headers, body: putBody });
    if (!putRes.ok) {
      const err = await putRes.json();
      return res.status(500).json({ error: 'GitHub PUT failed: ' + (err.message || putRes.status) });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
