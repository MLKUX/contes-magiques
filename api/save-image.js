// GITHUB_TOKEN : créer sur github.com/settings/tokens
// avec droits "repo" (full control)
// GITHUB_REPO : "MLKUX/contes-magiques"
// Ajouter ces deux variables dans Vercel Dashboard
// → Settings → Environment Variables

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lecture en deux étapes pour supporter les gros fichiers (>1 MB)
// Étape 1 : /contents/index.html → sha du fichier
// Étape 2 : /git/blobs/{sha} avec Accept raw → contenu brut
async function readIndexHtml(GITHUB_REPO, GITHUB_TOKEN) {
  const baseHeaders = {
    'Authorization': 'Bearer ' + GITHUB_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const CONTENTS_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';

  // Étape 1 : récupérer les métadonnées (sha)
  const metaRes = await fetch(CONTENTS_URL, {
    headers: Object.assign({}, baseHeaders, { 'Accept': 'application/vnd.github+json' })
  });
  if (!metaRes.ok) {
    const body = await metaRes.text();
    throw Object.assign(new Error('GitHub contents fetch failed: ' + metaRes.status), { httpStatus: metaRes.status, body });
  }
  const meta = await metaRes.json();
  const sha = meta.sha;

  // Étape 2 : lire le contenu brut via l'API blobs
  const blobRes = await fetch(
    'https://api.github.com/repos/' + GITHUB_REPO + '/git/blobs/' + sha,
    { headers: Object.assign({}, baseHeaders, { 'Accept': 'application/vnd.github.raw+json' }) }
  );
  if (!blobRes.ok) {
    const body = await blobRes.text();
    throw Object.assign(new Error('GitHub blob fetch failed: ' + blobRes.status), { httpStatus: blobRes.status, body });
  }
  const content = await blobRes.text();
  return { sha, content };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Route POST : sauvegarder l'image dans index.html ────────────────────────
  const { storyId, sceneId, imageBase64 } = req.body || {};
  if (!storyId || !sceneId || !imageBase64) {
    return res.status(400).json({ error: 'storyId, sceneId and imageBase64 are required' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN or GITHUB_REPO not configured' });
  }

  try {
    // 1. Lire index.html (deux étapes : sha via /contents, contenu via /git/blobs)
    const { sha, content } = await readIndexHtml(GITHUB_REPO, GITHUB_TOKEN);

    // 2a. Trouver le bloc story
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

    // Borner la fin du bloc story
    const nextStoryPattern = /id:\s*['"][a-z0-9-]+['"],/g;
    nextStoryPattern.lastIndex = storyStart + storyMatch[0].length + 1;
    const nextStoryMatch = nextStoryPattern.exec(content);
    const storyEnd = nextStoryMatch ? nextStoryMatch.index : content.length;
    const storyBlock = content.substring(storyStart, storyEnd);

    // 2b. Trouver la scène dans le bloc story
    const scenePattern = new RegExp("id:\\s*['\"]" + escapeRegex(sceneId) + "['\"]");
    const sceneMatch = scenePattern.exec(storyBlock);
    if (!sceneMatch) {
      const globalMatch = scenePattern.exec(content);
      const approxIdx = content.indexOf(sceneId);
      const context = approxIdx > -1
        ? content.substring(Math.max(0, approxIdx - 100), approxIdx + 100)
        : '(not found anywhere)';
      return res.status(404).json({
        error: 'Scene not found in story block',
        storyId, sceneId,
        searchedPattern: scenePattern.source,
        foundInFullFile: !!globalMatch,
        context200chars: context
      });
    }

    const sceneStart = storyStart + sceneMatch.index;

    // Borner la fin de la scène
    const nextScenePattern = new RegExp("id:\\s*['\"](?!" + escapeRegex(sceneId) + "['\"])");
    nextScenePattern.lastIndex = sceneMatch.index + sceneMatch[0].length;
    const nextSceneMatch = nextScenePattern.exec(storyBlock);
    const sceneEnd = nextSceneMatch ? storyStart + nextSceneMatch.index : storyEnd;
    const sceneBlock = content.substring(sceneStart, sceneEnd);

    // 2c. Remplacer cachedImage (toutes variantes de guillemets, avec/sans espace)
    const cachedPattern = /cachedImage:\s*["'][^"']*["']/;
    const cachedMatch = cachedPattern.exec(sceneBlock);
    if (!cachedMatch) {
      return res.status(404).json({
        error: 'cachedImage field not found in scene block',
        storyId, sceneId,
        searchedPattern: cachedPattern.source,
        sceneBlockPreview: sceneBlock.substring(0, 300)
      });
    }

    const cachedAbsoluteIdx = sceneStart + cachedMatch.index;
    const newContent =
      content.substring(0, cachedAbsoluteIdx) +
      'cachedImage:"' + imageBase64 + '"' +
      content.substring(cachedAbsoluteIdx + cachedMatch[0].length);

    // 3. Écrire via l'API Contents (PUT avec le sha récupéré à l'étape 1)
    const CONTENTS_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';
    const putRes = await fetch(CONTENTS_URL, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'cache: ' + storyId + '/' + sceneId + ' image validated',
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        sha
      })
    });

    if (!putRes.ok) {
      const err = await putRes.json();
      return res.status(500).json({ error: 'GitHub PUT failed: ' + (err.message || putRes.status) });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message, httpStatus: err.httpStatus, body: err.body });
  }
};
