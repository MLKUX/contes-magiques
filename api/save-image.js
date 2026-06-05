// GITHUB_TOKEN : créer sur github.com/settings/tokens
// avec droits "repo" (full control)
// GITHUB_REPO : "MLKUX/contes-magiques"
// Ajouter ces deux variables dans Vercel Dashboard
// → Settings → Environment Variables

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lecture en deux étapes pour supporter les gros fichiers (>1 MB)
async function readIndexHtml(GITHUB_REPO, GITHUB_TOKEN) {
  const baseHeaders = {
    'Authorization': 'Bearer ' + GITHUB_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const CONTENTS_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';

  const metaRes = await fetch(CONTENTS_URL, {
    headers: Object.assign({}, baseHeaders, { 'Accept': 'application/vnd.github+json' })
  });
  if (!metaRes.ok) {
    const body = await metaRes.text();
    throw Object.assign(new Error('GitHub contents fetch failed: ' + metaRes.status), { httpStatus: metaRes.status, body });
  }
  const meta = await metaRes.json();
  const sha = meta.sha;

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

// Récupère le SHA d'un fichier existant (pour éviter le 422 sur PUT si le fichier existe déjà)
async function getFileSha(url, GITHUB_TOKEN) {
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

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

  const imagePath = 'public/images/' + storyId + '-' + sceneId + '.png';
  const imageUrl  = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + imagePath;
  const publicUrl = '/images/' + storyId + '-' + sceneId + '.png';

  try {
    // 1. Sauvegarder l'image PNG dans /public/images/
    const rawBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const existingSha = await getFileSha(imageUrl, GITHUB_TOKEN);

    const putImageBody = {
      message: 'cache: save image ' + storyId + '/' + sceneId,
      content: rawBase64
    };
    if (existingSha) putImageBody.sha = existingSha;

    const putImageRes = await fetch(imageUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(putImageBody)
    });

    if (!putImageRes.ok) {
      const err = await putImageRes.json();
      return res.status(500).json({ error: 'GitHub image PUT failed: ' + (err.message || putImageRes.status) });
    }

    // 2. Lire index.html et mettre à jour cachedImage
    const { sha: htmlSha, content } = await readIndexHtml(GITHUB_REPO, GITHUB_TOKEN);

    // Trouver le bloc story
    const storyPattern = new RegExp("id:\\s*['\"]" + escapeRegex(storyId) + "['\"]");
    const storyMatch = storyPattern.exec(content);
    if (!storyMatch) {
      return res.status(404).json({ error: 'Story not found', storyId });
    }
    const storyStart = storyMatch.index;

    const nextStoryPattern = /id:\s*['"][a-z0-9-]+['"],/g;
    nextStoryPattern.lastIndex = storyStart + storyMatch[0].length + 1;
    const nextStoryMatch = nextStoryPattern.exec(content);
    const storyEnd = nextStoryMatch ? nextStoryMatch.index : content.length;
    const storyBlock = content.substring(storyStart, storyEnd);

    // Trouver la scène
    const scenePattern = new RegExp("id:\\s*['\"]" + escapeRegex(sceneId) + "['\"]");
    const sceneMatch = scenePattern.exec(storyBlock);
    if (!sceneMatch) {
      return res.status(404).json({ error: 'Scene not found', storyId, sceneId });
    }

    const sceneStart = storyStart + sceneMatch.index;
    const nextScenePattern = new RegExp("id:\\s*['\"](?!" + escapeRegex(sceneId) + "['\"])");
    nextScenePattern.lastIndex = sceneMatch.index + sceneMatch[0].length;
    const nextSceneMatch = nextScenePattern.exec(storyBlock);
    const sceneEnd = nextSceneMatch ? storyStart + nextSceneMatch.index : storyEnd;
    const sceneBlock = content.substring(sceneStart, sceneEnd);

    // Remplacer cachedImage par le chemin public
    const cachedPattern = /cachedImage:\s*["'][^"']*["']/;
    const cachedMatch = cachedPattern.exec(sceneBlock);
    if (!cachedMatch) {
      return res.status(404).json({ error: 'cachedImage field not found', storyId, sceneId });
    }

    const cachedAbsoluteIdx = sceneStart + cachedMatch.index;
    const newContent =
      content.substring(0, cachedAbsoluteIdx) +
      'cachedImage:"' + publicUrl + '"' +
      content.substring(cachedAbsoluteIdx + cachedMatch[0].length);

    // 3. Écrire index.html mis à jour
    const CONTENTS_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/index.html';
    const putHtmlRes = await fetch(CONTENTS_URL, {
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
        sha: htmlSha
      })
    });

    if (!putHtmlRes.ok) {
      const err = await putHtmlRes.json();
      return res.status(500).json({ error: 'GitHub HTML PUT failed: ' + (err.message || putHtmlRes.status) });
    }

    return res.status(200).json({ success: true, imagePath: publicUrl });

  } catch (err) {
    return res.status(500).json({ error: err.message, httpStatus: err.httpStatus });
  }
};
