/**
 * champs.js
 *
 * Nettoyage et validation des champs texte, partagés par les contrôleurs.
 *
 * Extraits d'authController quand un deuxième contrôleur (les établissements)
 * en a eu besoin : deux copies auraient fini par diverger, et c'est exactement
 * le genre de règle — « une chaîne d'espaces n'est pas une valeur » — qui doit
 * s'appliquer partout de la même façon.
 */

/**
 * Valide un champ texte obligatoire et renvoie sa version nettoyée.
 *
 * Une suite d'espaces n'est pas une valeur : sans ce contrôle, un `nom` fait
 * de blancs passait les validations de longueur côté client comme côté
 * Firestore, et le compte se retrouvait affiché par son email partout.
 * Les espaces internes multiples sont réduits à un seul, pour que « Jean   Luc »
 * et « Jean Luc » ne soient pas deux valeurs différentes dans les tris.
 */
function texteRequis(valeur, libelle, max = 100) {
    const propre = String(valeur ?? '').trim().replace(/\s+/g, ' ');
    if (!propre) {
        const err = new Error(`${libelle} est obligatoire.`);
        err.status = 400;
        throw err;
    }
    if (propre.length > max) {
        const err = new Error(`${libelle} ne doit pas dépasser ${max} caractères.`);
        err.status = 400;
        throw err;
    }
    return propre;
}

/** Texte facultatif nettoyé, avec longueur maximale (adresse, notes…). */
function texteOptionnel(valeur, libelle, max = 200) {
    if (valeur === undefined || valeur === null) return '';
    const propre = String(valeur).trim().replace(/\s+/g, ' ');
    if (propre.length > max) {
        const err = new Error(`${libelle} ne doit pas dépasser ${max} caractères.`);
        err.status = 400;
        throw err;
    }
    return propre;
}

module.exports = { texteRequis, texteOptionnel };
