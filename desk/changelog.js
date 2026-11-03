// Nouveautés d'Astrea Desk, pour le client final : ce qu'il peut faire de
// nouveau, en une phrase, sans jargon ni détail technique (le détail est dans
// docs/ASTREA-DESK.md). À compléter à chaque publication qui change quelque
// chose de visible : ajouter l'entrée en tête, avec la version publiée.
import { $, esc } from '../admin-tools/common/core.js?v=0.9.6';

export const CHANGES = [
  { v: '0.9.5', date: '3 novembre 2026', items: [
    'Nouvelle page « Nouveautés » : retrouvez ici les ajouts de chaque version.',
  ] },
  { v: '0.9.4', date: '3 novembre 2026', items: [
    "Journal d'appels : choix de plusieurs utilisateurs à la fois, avec « Tout cocher » et « Tout décocher ».",
    "Journal d'appels : nouveau filtre « Appels vers le groupe » pour voir les appels arrivés sur un groupe d'appels.",
    "Statistiques : lien direct vers le journal d'appels d'un groupe ou de plusieurs utilisateurs.",
    'Export PDF : police des rapports plus nette.',
    'Annuaire : le prénom et le numéro sont obligatoires, comme dans le Portal.',
    "Textes plus simples et messages d'erreur plus clairs sur tous les écrans.",
  ] },
  { v: '0.8', date: '2 et 3 novembre 2026', items: [
    "Files d'attente : un agent connecté mais qui ne reçoit pas les appels est signalé.",
    'Dashboard : nouvel indicateur « Agents injoignables ».',
    "Groupes d'appels : colonne « Par touche », qui indique si un membre est probablement entré ou sorti du groupe avec la touche de son téléphone.",
    'Le son en cours de lecture s\'arrête quand vous changez de page.',
  ] },
  { v: '0.7', date: '2 novembre 2026', items: [
    'Sons & Musiques : écoute, ajout et remplacement des messages, musiques d\'attente et tons d\'enregistrement. Vos fichiers sont convertis automatiquement au bon format.',
    'Annuaire : contacts partagés, recherche, import et export pour Excel.',
    "Files d'attente : connexion, déconnexion et pause des agents directement depuis la liste.",
    'Astrea Desk se met à jour tout seul au démarrage.',
  ] },
  { v: '0.6', date: '2 novembre 2026', items: [
    'Menu organisé comme celui du Portal Wazo.',
    "Modification des utilisateurs, groupes d'appels, messageries, appels entrants et sortants, SVI, conférences et files d'attente.",
    "Plages horaires : grille visuelle des heures d'ouverture, fermetures exceptionnelles et jours fériés.",
  ] },
  { v: '0.5', date: '2 novembre 2026', items: [
    'État des téléphones en direct : en appel, disponible, hors ligne, ne pas déranger.',
  ] },
  { v: '0.4', date: '2 novembre 2026', items: [
    "Dashboard : appels en cours, agents, files et appels du jour sur la page d'accueil.",
    'Option « Rester connecté » sur votre poste.',
  ] },
  { v: '0.3', date: '29 octobre 2026', items: [
    "Statistiques des files d'attente et des agents, avec les raisons des appels perdus.",
  ] },
  { v: '0.2', date: '29 octobre 2026', items: [
    "Journal d'appels : filtres, graphiques et exports Excel, page web et PDF.",
  ] },
  { v: '0.1', date: '29 octobre 2026', items: [
    'Première version : connexion avec votre compte du Portal Wazo et choix du site.',
  ] },
];

// Point « nouveau » sur le bouton tant que la dernière version n'a pas été lue.
const SEEN_KEY = 'astrea-desk-seen';
export function markNews() {
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* stockage indisponible */ }
  $('ft-news')?.classList.toggle('dk-new', seen !== CHANGES[0].v);
}

export function renderNews(view) {
  try { localStorage.setItem(SEEN_KEY, CHANGES[0].v); } catch { /* */ }
  markNews();
  view.innerHTML = `<div class="phonehead"><div><h2>Nouveautés</h2><div class="muted small">Ce qui a changé dans Astrea Desk, de la plus récente à la plus ancienne.</div></div></div>`
    + `<div class="dk-news">${CHANGES.map((c, i) => `<section class="dk-news-v${i === 0 ? ' latest' : ''}"><h3>${i === 0 ? '<span class="dk-badge">Dernière version</span> ' : ''}${esc(c.date)} <span class="muted small">· version ${esc(c.v)}</span></h3><ul>${c.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>`).join('')}</div>`;
  // Retour en haut, sans scrollIntoView : dans l'iframe, il fait aussi défiler
  // l'appli Wazo autour (en-tête de l'appli coupé, vu par Brice le 03/11/2026).
  for (const el of [$('workbench'), document.scrollingElement]) if (el) el.scrollTop = 0;
}
