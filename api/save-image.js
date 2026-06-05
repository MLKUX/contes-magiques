// GITHUB_TOKEN : créer sur github.com/settings/tokens
// avec droits "repo" (full control)
// GITHUB_REPO : "MLKUX/contes-magiques"
// Ajouter ces deux variables dans Vercel Dashboard
// → Settings → Environment Variables

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Route de debug GET ?debug=true ──────────────────────────────────────────
  if (req.method === 'GET' && req.query && req.query.debug === 'true') {
    const debugStoryId = req.query.storyId || 'kiko-etoile';
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO  = process.env.GITHUB_REPO;
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      return res.status(500).json({ error: 'GITHUB_TOKEN or GITHUB_REPO not configured' });
    }
    const API = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';
    const headers = {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    try {
      const getRes = await fetch(API, { headers });
      const githubStatus = getRes.status;
      const githubHeaders = {};
      getRes.headers.forEach((val, key) => { githubHeaders[key] = val; });

      const rawBody = await getRes.text();

      // Diagnostics de base (avant tout parsing)
      const diag = {
        env: {
          githubTokenDefined: !!GITHUB_TOKEN,
          githubRepoDefined: !!GITHUB_REPO,
          githubRepoFirst5: GITHUB_REPO ? GITHUB_REPO.substring(0, 5) : null
        },
        github: {
          status: githubStatus,
          headers: githubHeaders,
          rawBodyFirst200: rawBody.substring(0, 200)
        }
      };

      if (!getRes.ok) {
        return res.status(500).json({ error: 'GitHub GET failed', ...diag });
      }

      // Parsing
      let fileData;
      try {
        fileData = JSON.parse(rawBody);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to parse GitHub JSON', parseError: e.message, ...diag });
      }

      const b64Content = fileData.content || '';
      const content = Buffer.from(b64Content, 'base64').toString('utf8');

      const idx = content.indexOf(debugStoryId);
      const before = idx > -1 ? content.substring(Math.max(0, idx - 50), idx) : null;
      const after  = idx > -1 ? content.substring(idx, idx + 150) : null;

      const storyPattern = new RegExp("id:\\s*['\"]" + escapeRegex(debugStoryId) + "['\"]");
      const storyMatch = storyPattern.exec(content);

      return res.status(200).json({
        ...diag,
        storyId: debugStoryId,
        contentLength: content.length,
        contentFirst100: content.substring(0, 100),
        indexOf: idx,
        context: { before, after },
        regexPattern: storyPattern.source,
        regexMatch: storyMatch ? storyMatch[0] : null,
        regexPosition: storyMatch ? storyMatch.index : null
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

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

    // 2a. Trouver le début du bloc story (pour borner la recherche)
    const storyPattern = new RegExp("id:\\s*['\"]" + escapeRegex(storyId) + "['\"]");
    const storyMatch = storyPattern.exec(content);
    if (!storyMatch) {
      const kikoIdx = content.indexOf('kiko-etoile');
      return res.status(404).json({
        error: 'Story not found in index.html',
        storyId,
        searchedPattern: storyPattern.source,
        contentLength: content.length,
        contentFirst100: content.substring(0, 100),
        kikoEtoileFound: kikoIdx !== -1,
        kikoEtoilePosition: kikoIdx
      });
    }
    const storyStart = storyMatch.index;

    // Trouver le début du prochain story (pour borner la fin)
    const nextStoryPattern = /id:\s*['"][a-z0-9-]+['"],/g;
    nextStoryPattern.lastIndex = storyStart + storyMatch[0].length + 1;
    const nextStoryMatch = nextStoryPattern.exec(content);
    const storyEnd = nextStoryMatch ? nextStoryMatch.index : content.length;

    const storyBlock = content.substring(storyStart, storyEnd);

    // 2b. Trouver la scène dans le bloc story
    //     Accepte: id:'sceneId' ou id: 'sceneId' ou id:"sceneId" ou id: "sceneId"
    const scenePattern = new RegExp("id:\\s*['\"]" + escapeRegex(sceneId) + "['\"]");
    const sceneMatch = scenePattern.exec(storyBlock);

    if (!sceneMatch) {
      // Chercher quand même dans tout le fichier pour le debug
      const globalMatch = scenePattern.exec(content);
      const approxIdx = content.indexOf(sceneId);
      const context = approxIdx > -1
        ? content.substring(Math.max(0, approxIdx - 100), approxIdx + 100)
        : '(not found anywhere)';

      return res.status(404).json({
        error: 'Scene not found in story block',
        storyId,
        sceneId,
        searchedPattern: scenePattern.source,
        foundInFullFile: globalMatch ? true : false,
        context200chars: context
      });
    }

    const sceneStart = storyStart + sceneMatch.index;

    // Trouver la prochaine scène pour borner la recherche de cachedImage
    const nextScenePattern = new RegExp("id:\\s*['\"](?!" + escapeRegex(sceneId) + "['\"])");
    nextScenePattern.lastIndex = sceneMatch.index + sceneMatch[0].length;
    const nextSceneMatch = nextScenePattern.exec(storyBlock);
    const sceneEnd = nextSceneMatch
      ? storyStart + nextSceneMatch.index
      : storyEnd;

    const sceneBlock = content.substring(sceneStart, sceneEnd);

    // 2c. Trouver et remplacer cachedImage dans le bloc de la scène
    //     Accepte toutes variantes : cachedImage:"" / cachedImage:'' / cachedImage: "" / cachedImage: ''
    //     Y compris si déjà rempli (re-save)
    const cachedPattern = /cachedImage:\s*["'][^"']*["']/;
    const cachedMatch = cachedPattern.exec(sceneBlock);

    if (!cachedMatch) {
      return res.status(404).json({
        error: 'cachedImage field not found in scene block',
        storyId,
        sceneId,
        searchedPattern: cachedPattern.source,
        sceneBlockPreview: sceneBlock.substring(0, 300)
      });
    }

    // Remplacer dans le contenu complet
    const cachedAbsoluteIdx = sceneStart + cachedMatch.index;
    const newContent =
      content.substring(0, cachedAbsoluteIdx) +
      'cachedImage:"' + imageBase64 + '"' +
      content.substring(cachedAbsoluteIdx + cachedMatch[0].length);

    // 3. Commit via l'API GitHub
    const putBody = JSON.stringify({
      message: 'cache: ' + storyId + '/' + sceneId + ' image validated',
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha
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
