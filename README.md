# iris-ashby-slack

## Tri automatique des candidatures

Lundi, mercredi et vendredi à 9h (Paris), pour chaque poste ouvert dans Ashby qui a une page **Kick off** et une page **Scorecard** remplies sous sa page dans Notion > Job infos (même nom que le poste Ashby), Iris trie les candidatures en *Application Review* avec Claude et envoie un message privé au recruteur du poste. Lecture seule dans Ashby.

- Code : `lib/tri.js` (tri + message), `lib/notion.js` (critères + journal), `api/cron/tri.js`, `api/tri-poste.js`
- Journal (mémoire d'Iris, rien à y faire) : base Notion « Journal de tri » dans la page privée « Iris – Journal de tri ». Supprimer une ligne force le re-tri du candidat.
- Interrupteur : le cron ne fait rien tant que la variable Vercel `TRI_ACTIF` n'est pas à `1` (le mode test marche sans)
- Variables Vercel en plus : `ANTHROPIC_API_KEY`, `NOTION_TOKEN` (l'intégration Notion doit être connectée à Job infos et au journal)
- Test sur un poste, message à Léa seulement, journal pas modifié (header `Authorization: Bearer CRON_SECRET`) :
  `/api/tri-poste?job=<jobId>&test=1` (ajouter `&fresh=1` pour relire tous les CV)

### Bouton « Refuser les N écartés »

Dans le message de tri (pas en mode test), un bouton avec confirmation envoie le mail de refus et archive dans Ashby les candidats **écartés** (verdict du journal) **encore en Application Review** au moment du clic. Les « sans CV » ne sont jamais touchés. Le tri reste en lecture seule : seul ce clic écrit dans Ashby.

- Code : `lib/refus.js` (appelé par `api/slack-interactions.js`)
- Mail : template Ashby « Application Rejection », ou « Application rejection - EN » pour les postes à l'étranger (pays du lieu du poste, sinon titre). Envoyé par Ashby à son heure par défaut (le lendemain matin, 9h32).
- Raison d'archivage : constante `RAISON` dans `lib/refus.js`. Tant qu'elle est vide ou introuvable, le clic ne fait rien et liste les raisons disponibles.
- Interrupteur : tant que la variable Vercel `REFUS_ACTIF` n'est pas à `1`, un clic fait un essai à sec (il dit qui serait refusé, rien n'est écrit) et le bouton reste.
- La clé API Ashby doit avoir le droit `candidatesWrite` (et `communicationTemplatesRead`).
