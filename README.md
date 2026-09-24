# zotero-mcp

Serveur MCP (Model Context Protocol) **zéro dépendance** pour l'
[API Web Zotero v3](https://www.zotero.org/support/dev/web_api/v3/basics).

- Node.js >= 18, aucun `npm install`
- 3 modes : **stdio** (client MCP local), **app locale** (HTTP sur
  `http://127.0.0.1:3334`, lancé dans un terminal) et **HTTP** (déploiement
  permanent, systemd)
- 19 outils : recherche et listing d'items/collections/tags/recherches
  sauvegardées, gabarits d'items, bibliographies formatées (APA, Chicago...),
  exports (BibTeX, RIS, CSL JSON...), CRUD d'items et de collections
- Préconditions de version (verrouillage optimiste Zotero) gérées
  automatiquement : `If-Unmodified-Since-Version` / `Zotero-Write-Token`
- Rate limiting Zotero géré : en-tête `Backoff`, retry sur 429/503 avec
  `Retry-After`
- Sans clé API : lecture des bibliothèques publiques (passer `user_id` /
  `group_id` dans les appels)

## App locale (HTTP sur localhost)

```bash
git clone <repo> zotero-mcp
cd zotero-mcp
node server.js          # lancé dans un terminal -> app locale automatique
```

Lancé directement dans un terminal (stdin interactif), `server.js` démarre en
**app locale** : serveur MCP HTTP sur `http://127.0.0.1:3334` avec une bannière
d'accueil. Lancé par un client MCP (stdin redirigé — Claude Desktop, Vibe CLI,
...), il reste en mode **stdio**, le comportement des clients est inchangé.
Forçage possible : `node server.js --local` / `--http` / `--stdio`.

## Configuration

Sans variable d'environnement — fichier `zotero-mcp.json` (cherché à côté de
`server.js`, puis dans le répertoire courant, puis
`%APPDATA%\zotero-mcp\config.json` ; les variables d'environnement restent
prioritaires) :

```json
{
  "apiKey": "ta_cle_zotero",
  "userId": 123456,
  "apiBase": "https://api.zotero.org",
  "bind": "127.0.0.1",
  "port": 3334,
  "httpToken": ""
}
```

- `apiKey` : clé API Zotero — https://www.zotero.org/settings/keys
  (cocher *Allow library access* + *Allow write access* si besoin).
- `userId` : identifiant **numérique** (pas le pseudo), visible sur la page
  des clés. Facultatif : il est détecté automatiquement via `/keys/current`.
- `apiBase` : `https://api.zotero.org` (défaut) ou
  `http://localhost:23119/api` pour l'API locale du client desktop Zotero.

Variables d'environnement équivalentes : `ZOTERO_API_KEY`, `ZOTERO_USER_ID`,
`ZOTERO_API_BASE`, `ZOTERO_MCP_PORT`, `ZOTERO_MCP_BIND`,
`ZOTERO_MCP_HTTP_TOKEN`.

**Le fichier `zotero-mcp.json` contient la clé API : il est dans `.gitignore`.**

## Config du client MCP

stdio (même machine) :

```toml
[[mcp_servers]]
name = "zotero"
command = "node"
args = ["C:\\Users\\tortu\\git\\zotero-mcp\\server.js"]
env = { ZOTERO_API_KEY = "ta_cle", ZOTERO_USER_ID = "123456" }
```

ou via l'app locale HTTP :

```toml
[[mcp_servers]]
name = "zotero"
url = "http://127.0.0.1:3334"
```

## Outils

| Outil | Description |
|---|---|
| `zotero_health` | Connectivité + privilèges de la clé (userID, accès par bibliothèque) |
| `zotero_search_items` | Recherche rapide (`q`, `qmode`, `tag`, `itemType`, booléens) |
| `zotero_list_items` | Items (tous, top, corbeille, My Publications, par collection), tri/pagination/`since`, `format` json/keys/versions, `all_pages` |
| `zotero_get_item` | Un item par clé (+ `include` bib/citation) |
| `zotero_list_item_children` | Enfants d'un item (notes, pièces jointes) |
| `zotero_list_item_tags` | Tags d'un item |
| `zotero_list_collections` | Collections (toutes ou racines), `all_pages` |
| `zotero_get_collection` | Une collection par clé |
| `zotero_list_tags` | Tags de la bibliothèque |
| `zotero_list_searches` | Recherches sauvegardées |
| `zotero_item_template` | Gabarit JSON éditable pour un type d'item |
| `zotero_bibliography` | Bibliographie XHTML (CSL style, locale), collection ou clés |
| `zotero_export_items` | Export BibTeX, RIS, CSL JSON, CSV, TEI... |
| `zotero_create_items` | Création d'items (1 à 50, depuis les gabarits) |
| `zotero_update_item` | PATCH d'un item (champs modifiés seulement) |
| `zotero_delete_items` | Suppression d'items (1 à 50) |
| `zotero_create_collections` | Création de collections (hiérarchie possible) |
| `zotero_delete_collections` | Suppression de collections (1 à 50) |
| `zotero_delete_tags` | Suppression de tags dans toute la bibliothèque |

Bibliothèques de groupe : passer `group_id` à n'importe quel outil. Sans
clé API, seules les bibliothèques publiques sont lisibles (`user_id`/`group_id`).

Exemples d'appels (JSON-RPC `tools/call`) :

```json
{"name": "zotero_search_items", "arguments": {"q": "machine learning", "limit": 10}}
{"name": "zotero_bibliography", "arguments": {"collection": "9KH9TNSJ", "style": "apa", "locale": "fr-FR"}}
{"name": "zotero_create_items", "arguments": {"items": [{"itemType": "book", "title": "Mon livre"}]}}
{"name": "zotero_update_item", "arguments": {"key": "ABCD2345", "fields": {"tags": [{"tag": "lu"}]}}}
```

## Tests

```bash
bash test/run.sh
```

- **Suite mock** (`test/mock-zotero.js`) : tous les chemins, y compris les
  écritures avec leurs préconditions de version (412/428) — sans réseau.
- **Suite réelle** : lecture seule contre `api.zotero.org` (bibliothèque
  publique de la doc Zotero, sans clé) — valide le client HTTP, la pagination
  `Link`, les formats bib/bibtex/keys/versions et le clamping `limit<=100`.

Machine de développement sans Node : les tests tournent dans Docker :

```bash
docker run --rm -v "$PWD:/app" -w /app node:20-alpine \
  sh -c "apk add --no-cache bash && bash test/run.sh"
```

## Déploiement Windows (.exe autonome)

`dist\zotero-mcp.exe` est un **Single Executable Application** Node : le
runtime est embarqué dans l'exe, la machine cible n'a besoin de **rien**
(ni Node, ni npm). Il démarre en HTTP sur `http://127.0.0.1:3334` et lit
`zotero-mcp.json` placé à côté de lui.

```powershell
# Machine de build (Node >= 20 + npm) :
node windows\build.mjs       # -> dist\zotero-mcp.exe (+ smoke test automatique)

# Config : copier le zotero-mcp.json avec la clé à côté de l'exe
# Lancer :
dist\zotero-mcp.exe          # -> http://127.0.0.1:3334
curl http://127.0.0.1:3334/  # {"status":"ok",...}

# Démarrage automatique à l'ouverture de session (tache planifiée masquée) :
powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1
#   Retirer : ... -Uninstall
```

Re-exécuter `build.mjs` après chaque modification de `server.js` : l'exe est
un instantané, il ne lit pas `server.js` au runtime.

Machine sans Node installé : un Node 20 **portable** (zip extrait, aucune
installation système, ignoré par git) suffit :

```bash
curl -LO https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip
tar -xf node-v20.20.2-win-x64.zip          # bsdtar Windows, pas GNU tar
PATH="$PWD/node-v20.20.2-win-x64:$PATH" ./node-v20.20.2-win-x64/node.exe windows/build.mjs
```

Note : l'injection postject invalide la signature Microsoft du binaire Node
(avertissement « The signature seems corrupted ») — normal et attendu.

## Limites

- Réponses MCP tronquées à 100 000 caractères : utiliser `limit`, les formats
  `keys`/`versions` ou `q` pour cibler.
- `format=bib` plafonné à 150 items côté Zotero — préférer les collections.
- Upload de fichiers (pièces jointes PDF) non implémenté (flux S3 multi-étapes).
