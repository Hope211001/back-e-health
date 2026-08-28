/**
 * apifyService.js
 *
 * Récupération des publications d'une page Facebook via l'actor Apify
 * `apify/facebook-posts-scraper`. Reprend le nœud « Run an Actor » du workflow
 * n8n de scraping.
 *
 * Pourquoi Apify et pas une requête directe : Facebook bloque tout accès
 * serveur aux photos. Les liens de page `photo.php?fbid=` renvoient une page de
 * blocage, la balise `og:image` est retirée, et l'endpoint `/picture` du Graph
 * ne donne qu'une image générique. Seul un vrai navigateur — ce que fait
 * l'actor — obtient les URLs `image.uri` directes, qui sont la seule source
 * exploitable des affiches.
 *
 * Ces URLs `fbcdn.net` EXPIRENT (paramètre `oe=`) : elles doivent être
 * ré-hébergées tout de suite, sans quoi les affiches deviennent des images
 * mortes au bout de quelques jours. C'est le rôle de l'upload Cloudinary dans
 * ingestionPharmacieGardeService.js.
 *
 * L'actor `scraper_one/facebook-posts-scraper` (id zanTWNqB3Poz44qdY) a été
 * essayé et écarté : il ne renvoie que des liens de page, jamais les images.
 *
 * Variables d'environnement :
 *   - APIFY_API_TOKEN     (obligatoire)
 *   - APIFY_ACTOR_ID      (optionnel) défaut : l'actor officiel Facebook posts
 *   - APIFY_PAGE_DEFAUT   (optionnel) page scrapée si aucune n'est fournie
 *   - APIFY_TIMEOUT_S     (optionnel) plafond d'exécution côté Apify
 */

/** Actor officiel Apify « Facebook Posts Scraper ». */
const ACTOR_DEFAUT = 'KoJrdxJCTtpon81KY';

/** Page scrapée par défaut : celle qui publie les gardes de Madagascar. */
const PAGE_DEFAUT = 'https://www.facebook.com/pharmacie.madagascar/';

/**
 * Plafond d'exécution transmis à Apify. Un scraping Facebook dure typiquement
 * une à trois minutes ; au-delà, c'est que la page est inaccessible et il vaut
 * mieux rendre la main que laisser tourner un actor facturé.
 */
const TIMEOUT_DEFAUT_S = 300;

/** Nombre de publications récupérées si l'appelant n'en demande pas un autre. */
const RESULTS_LIMIT_DEFAUT = 10;

/**
 * Lance l'actor et renvoie directement les publications.
 *
 * `run-sync-get-dataset-items` fait en un seul appel ce que le workflow n8n
 * faisait en deux nœuds (lancer l'actor, puis lire l'URL du dataset) : Apify
 * attend la fin de l'exécution et renvoie les items.
 *
 * @param  {object} options
 * @param  {string} [options.pageUrl]      page Facebook à scraper
 * @param  {number} [options.resultsLimit] nombre de publications à remonter
 * @return {Promise<object[]>} publications brutes (postId, text, url, media[]…)
 */
async function recupererPublications({ pageUrl, resultsLimit } = {}) {
    const token = (process.env.APIFY_API_TOKEN || '').trim();
    if (!token) {
        const err = new Error(
            "APIFY_API_TOKEN absent du .env du backend : le scraping ne peut pas être lancé."
        );
        err.status = 503;
        throw err;
    }

    const url = String(pageUrl || process.env.APIFY_PAGE_DEFAUT || PAGE_DEFAUT).trim();
    if (!/^https?:\/\/(www\.)?facebook\.com\//i.test(url)) {
        const err = new Error('Lien invalide : une page facebook.com est attendue.');
        err.status = 400;
        throw err;
    }

    // Borné des deux côtés : 0 ne rapporterait rien, et au-delà de 100 le
    // scraping dépasse le temps d'attente acceptable et le quota Apify.
    const limite = Math.min(100, Math.max(1, Number(resultsLimit) || RESULTS_LIMIT_DEFAUT));

    const acteur = (process.env.APIFY_ACTOR_ID || ACTOR_DEFAUT).trim();
    const timeout = Number(process.env.APIFY_TIMEOUT_S) || TIMEOUT_DEFAUT_S;
    const endpoint =
        `https://api.apify.com/v2/acts/${acteur}/run-sync-get-dataset-items`
        + `?token=${encodeURIComponent(token)}&timeout=${timeout}`;

    let reponse;
    try {
        reponse = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // `captionText: false` : on ne veut pas les légendes des photos,
                // seulement le texte de la publication.
                captionText: false,
                resultsLimit: limite,
                startUrls: [{ url }],
            }),
        });
    } catch (error) {
        const err = new Error(`Apify injoignable : ${error.message}`);
        err.status = 502;
        throw err;
    }

    if (!reponse.ok) {
        const detail = await reponse.text().catch(() => '');
        let message = `Apify a répondu ${reponse.status}. ${detail.slice(0, 300)}`;
        if (reponse.status === 401 || reponse.status === 403) {
            message = 'Jeton Apify refusé. Vérifiez APIFY_API_TOKEN dans le .env.';
        } else if (reponse.status === 402) {
            message = "Crédit Apify épuisé : le scraping est indisponible jusqu'au renouvellement du quota.";
        } else if (reponse.status === 408) {
            message = "Le scraping a dépassé le temps imparti. Réessayez avec moins de publications.";
        }
        const err = new Error(message);
        err.status = reponse.status >= 400 && reponse.status < 500 ? reponse.status : 502;
        throw err;
    }

    const items = await reponse.json();
    return Array.isArray(items) ? items : [];
}

module.exports = { recupererPublications, ACTOR_DEFAUT, PAGE_DEFAUT };
