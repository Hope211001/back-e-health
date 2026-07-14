/**
 * pharmacieGardeMedia.js
 *
 * Récupère la vraie image d'une pièce jointe de pharmacie de garde et la
 * ré-héberge sur Firebase Storage.
 *
 * Problème résolu : le workflow n8n stocke dans `attachement` des liens de
 * PAGE Facebook (https://www.facebook.com/photo.php?fbid=...), pas des images.
 * Un <Image> ne peut pas les afficher. On extrait donc l'URL réelle de l'image
 * (balise og:image de la page), on télécharge le fichier, puis on l'upload sur
 * Storage → on obtient une URL permanente et publique (via download token).
 */
const crypto = require('crypto');
const { admin } = require('../config/firebase');

// User-Agent « navigateur » : Facebook renvoie mieux la balise og:image ainsi.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Décode les entités HTML fréquentes dans une URL extraite du HTML. */
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;?/g, '&')
    .replace(/&quot;/g, '"');
}

/** Extrait l'URL directe de l'image (og:image) depuis une page Facebook. */
async function resolveOgImage(pageUrl) {
  // Facebook renvoie parfois un mur de connexion sur www. On tente plusieurs
  // variantes d'hôte : www (balise og:image) puis mbasic (HTML simple avec
  // l'image en clair).
  const variants = [
    pageUrl,
    pageUrl.replace('://www.facebook.com', '://mbasic.facebook.com'),
    pageUrl.replace('://www.facebook.com', '://m.facebook.com'),
  ];

  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    // NB : le fallback "<img ...fbcdn>" a été retiré car il capturait des
    // images parasites (icônes/pixels ~700 octets) quand Facebook bloque.
  ];

  for (const url of variants) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const html = await res.text();
      for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) return decodeHtml(m[1]);
      }
    } catch {
      // On passe à la variante suivante.
    }
  }
  return null;
}

/**
 * Upload d'un buffer image sur Cloudinary (gratuit, sans carte). Retourne l'URL.
 * - Mode SIGNÉ (recommandé backend) : nécessite CLOUDINARY_API_KEY + _API_SECRET.
 * - Mode NON SIGNÉ (fallback) : nécessite un upload preset "Unsigned".
 */
async function uploadToCloudinary(buffer, contentType) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }));
  form.append('folder', 'pharamacieGarde');

  if (apiKey && apiSecret) {
    // Upload signé : on signe (paramètres triés + secret) en SHA1.
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha1')
      .update(`folder=pharamacieGarde&timestamp=${timestamp}${apiSecret}`)
      .digest('hex');
    form.append('api_key', apiKey);
    form.append('timestamp', String(timestamp));
    form.append('signature', signature);
  } else {
    // Upload non signé (via preset).
    form.append('upload_preset', preset);
  }

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Cloudinary: ${data?.error?.message || res.status}`);
  }
  return data.secure_url;
}

/** Upload d'un buffer image sur Firebase Storage. Retourne l'URL publique. */
async function uploadToFirebaseStorage(buffer, contentType, destPath) {
  const token = crypto.randomUUID();
  const bucket = admin.storage().bucket();
  const file = bucket.file(destPath);
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      // Ce token rend le fichier accessible publiquement via l'URL ci-dessous,
      // sans avoir à modifier les règles de sécurité Storage.
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(destPath)}?alt=media&token=${token}`;
}

/**
 * Télécharge une image et la ré-héberge. Retourne l'URL publique permanente.
 * Utilise Cloudinary si configuré (gratuit, sans carte), sinon Firebase Storage.
 */
async function rehostImage(imageUrl, destPath) {
  const res = await fetch(imageUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Téléchargement image échoué (HTTP ${res.status})`);

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());

  // Garde-fou : rejette les placeholders/pixels (Facebook renvoie souvent une
  // mini-image générique quand il bloque). Une vraie affiche fait > 10 Ko.
  if (buffer.length < 3000) {
    throw new Error(`Image trop petite (${buffer.length} octets) — probable placeholder Facebook.`);
  }

  const cloudinaryConfigure =
    process.env.CLOUDINARY_CLOUD_NAME &&
    ((process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) ||
      process.env.CLOUDINARY_UPLOAD_PRESET);

  if (cloudinaryConfigure) {
    return uploadToCloudinary(buffer, contentType);
  }
  return uploadToFirebaseStorage(buffer, contentType, destPath);
}

const isDirectImage = (url) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) || /fbcdn\.net/i.test(url);
const isFbPhotoPage = (url) => /facebook\.com\/.*(photo|fbid=)/i.test(url);
const isAlreadyStorage = (url) => url.includes('firebasestorage.googleapis.com');
const extractFbid = (url) => (url.match(/fbid=(\d+)/) || [])[1] || null;

/**
 * Traite un tableau `attachement` (liens de page FB ou URLs) et renvoie un
 * tableau d'URLs Storage permanentes. Les entrées déjà ré-hébergées ou
 * irrécupérables sont gérées proprement (on ne casse pas tout le lot).
 */
async function rehostAttachements(postId, attachements) {
  const out = [];
  for (let i = 0; i < attachements.length; i++) {
    const entry = attachements[i];
    const pageUrl = typeof entry === 'string' ? entry : entry?.url || '';
    if (!pageUrl) continue;

    // Déjà hébergé chez nous → on garde tel quel.
    if (isAlreadyStorage(pageUrl)) {
      out.push(pageUrl);
      continue;
    }

    try {
      let imageUrl = null;
      if (isDirectImage(pageUrl)) imageUrl = pageUrl;
      else if (isFbPhotoPage(pageUrl)) imageUrl = await resolveOgImage(pageUrl);

      if (!imageUrl) {
        console.warn(`⚠️ Image introuvable pour : ${pageUrl}`);
        continue;
      }

      const fbid = (typeof entry === 'object' && entry?.id) || extractFbid(pageUrl) || `${i}`;
      const url = await rehostImage(imageUrl, `pharamacieGarde/${postId}/${fbid}.jpg`);
      out.push(url);
    } catch (e) {
      console.warn(`⚠️ Ré-hébergement échoué (${pageUrl}) :`, e.message);
    }
  }
  return out;
}

module.exports = { resolveOgImage, rehostImage, rehostAttachements };
