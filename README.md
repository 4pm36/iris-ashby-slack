# iris-ashby-slack

## Tri automatique des candidatures

Lundi, mercredi et vendredi à 9h (Paris), pour chaque poste ouvert dans Ashby qui a une page **Kick off** et une page **Scorecard** remplies sous sa page dans Notion > Job infos (même nom que le poste Ashby), Iris trie les candidatures en *Application Review* avec Claude et envoie un message privé au recruteur du poste. Lecture seule dans Ashby.

- Code : `lib/tri.js` (tri + message), `lib/notion.js` (critères + journal), `api/cron/tri.js`, `api/tri-poste.js`
- Journal (mémoire d'Iris, rien à y faire) : base Notion « Journal de tri » dans la page privée « Iris – Journal de tri ». Supprimer une ligne force le re-tri du candidat.
- Interrupteur : le cron ne fait rien tant que la variable Vercel `TRI_ACTIF` n'est pas à `1` (le mode test marche sans)
- Variables Vercel en plus : `ANTHROPIC_API_KEY`, `NOTION_TOKEN` (l'intégration Notion doit être connectée à Job infos et au journal)
- Test sur un poste, message à Léa seulement, journal pas modifié (header `Authorization: Bearer CRON_SECRET`) :
  `/api/tri-poste?job=<jobId>&test=1` (ajouter `&fresh=1` pour relire tous les CV)
