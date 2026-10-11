# EML AdminTool - Player Data Synchronization

## 1. Objet

Cette spécification décrit l'ajout dans **EML-AdminTool** d'un système de synchronisation des données personnelles Minecraft entre plusieurs appareils utilisant le même launcher.

La synchronisation doit permettre de transférer automatiquement entre plusieurs installations du launcher des données telles que :

- mondes solo ;
- waypoints ;
- données JourneyMap/XaeroMap ;
- configurations utilisateur ;
- captures d'écran ;
- autres fichiers explicitement configurés par l'administrateur.

Cette fonctionnalité est appelée dans le reste du document :

**Player Data Synchronization**, ou simplement **Sync**.

Le système de synchronisation doit être distinct du **Files Updater** existant.

Le Files Updater distribue des fichiers contrôlés par l'administrateur vers les installations Minecraft.

La synchronisation fonctionne dans l'autre sens conceptuel : elle stocke et synchronise des données appartenant individuellement aux joueurs.

```text
Files Updater

AdminTool
   │
   ▼
Launcher
   │
   ▼
Minecraft


Player Sync

Minecraft appareil A
   │
   ▼
Launcher
   │
   ▼
AdminTool / Object Storage
   │
   ▼
Launcher
   │
   ▼
Minecraft appareil B
```

---

# 2. Objectifs

Le système doit permettre :

1. d'activer ou désactiver la synchronisation pour chaque `Profile` ;
2. de définir les chemins pouvant être synchronisés ;
3. de définir les fichiers ou dossiers exclus ;
4. d'identifier les joueurs utilisant le service ;
5. d'identifier les différents appareils d'un joueur ;
6. de maintenir un manifest distant des fichiers ;
7. de détecter les modifications concurrentes ;
8. de gérer les suppressions ;
9. de générer des URLs temporaires d'upload et de téléchargement ;
10. de stocker les fichiers dans un Object Storage compatible S3 ;
11. de gérer des quotas ;
12. de fournir des statistiques d'utilisation ;
13. de permettre à l'administrateur de supprimer les données d'un joueur ;
14. de ne jamais permettre à un joueur d'accéder aux données d'un autre joueur.

---

# 3. Non-objectifs

La première version ne doit pas implémenter :

- de synchronisation différentielle binaire ;
- de synchronisation par chunk Minecraft ;
- de merge intelligent de fichiers JourneyMap/Xaero ;
- de merge automatique de fichiers de configuration ;
- de WebSocket obligatoire ;
- de synchronisation P2P entre appareils ;
- de stockage des fichiers binaires dans PostgreSQL ;
- d'historique illimité de toutes les versions ;
- de synchronisation de l'intégralité d'une instance Minecraft sans règles explicites.

Ces fonctionnalités pourront être ajoutées ultérieurement.

---

# 4. Architecture générale

```text
┌───────────────────────────────────────────────┐
│                  EML Launcher                 │
│                                               │
│  EML Lib                                      │
│  Sync Engine                                  │
│  Local Manifest                               │
│                                               │
└──────────────────────┬────────────────────────┘
                       │
                       │ HTTPS
                       ▼
┌───────────────────────────────────────────────┐
│                EML AdminTool                  │
│                                               │
│  SvelteKit                                    │
│                                               │
│  Existing APIs                                │
│  ├── Profiles                                 │
│  ├── Files Updater                            │
│  ├── News                                     │
│  ├── Stats                                    │
│  └── Crash Reports                            │
│                                               │
│  New Sync API                                 │
│  ├── Authentication / identity                │
│  ├── Devices                                  │
│  ├── Manifest                                 │
│  ├── Upload                                   │
│  ├── Download                                 │
│  ├── Delete                                   │
│  ├── Conflicts                                │
│  └── Quotas                                   │
│                                               │
└───────────────┬───────────────────┬───────────┘
                │                   │
                ▼                   ▼
          PostgreSQL             S3 API
          via Prisma               │
                                   ▼
                         Object Storage
                         S3 / R2 / MinIO /
                         OVH Object Storage
```

PostgreSQL est la source de vérité pour les métadonnées.

Le stockage objet est la source de vérité pour le contenu binaire des fichiers.

---

# 5. Réutilisation des concepts existants

## 5.1 Profile

Le modèle `Profile` existant doit être réutilisé.

Un profil représente déjà une configuration Minecraft isolée avec ses propres fichiers, version Minecraft, loader et serveur.

La configuration Sync doit être attachée à un `Profile`.

Aucune nouvelle notion parallèle de "Minecraft Instance Type" ne doit être créée.

```text
Profile
├── Loader
├── Files Updater
├── Server
├── ...
└── Sync Configuration
```

---

# 6. Modèle d'authentification

## 6.1 Principe

La connexion réseau existante entre EML-Lib et EML-AdminTool doit être réutilisée.

Il ne faut pas créer un deuxième backend uniquement pour la synchronisation.

En revanche, les routes Sync doivent pouvoir identifier de manière fiable le joueur effectuant la requête.

Le serveur ne doit jamais considérer un UUID Minecraft envoyé directement par le client comme une preuve d'identité.

Interdit :

```json
{
  "minecraftUuid": "UUID_DU_JOUEUR"
}
```

avec une logique serveur faisant confiance directement à cette valeur.

Le joueur authentifié doit être déterminé à partir d'un token ou d'une preuve d'identité vérifiable côté serveur.

---

# 7. Player

Un modèle `Player` doit être distinct du modèle `User` utilisé pour l'administration du panel.

Le modèle `User` représente un administrateur ou membre du staff EML-AdminTool.

Le modèle `Player` représente un utilisateur du launcher.

```prisma
model Player {
  id            String   @id @default(cuid(2))
  minecraftUuid String   @unique
  minecraftName String?

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  devices       PlayerDevice[]
  syncFiles     SyncFile[]
  syncStates    PlayerSyncState[]
}
```

`minecraftUuid` doit être normalisé avant insertion.

Recommandation :

```text
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

ou systématiquement sans tirets.

Une seule représentation doit être utilisée dans toute l'application.

---

# 8. Appareils

Chaque installation du launcher doit posséder un identifiant d'appareil stable.

```prisma
model PlayerDevice {
  id              String   @id @default(cuid(2))
  playerId        String
  deviceUuid      String
  name            String
  platform        String
  arch            String?
  launcherVersion String?

  createdAt       DateTime @default(now())
  lastSeenAt      DateTime @default(now())

  player Player @relation(
    fields: [playerId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([playerId, deviceUuid])
  @@index([playerId])
}
```

Exemples :

```text
Desktop
Windows
x64

Surface Laptop
Windows
arm64
```

`deviceUuid` doit être créé une fois côté launcher et conservé localement.

Il ne doit pas être dérivé d'un identifiant matériel.

Exemple :

```text
UUID aléatoire généré lors de la première installation
```

---

# 9. Configuration Sync d'un Profile

```prisma
model SyncProfile {
  id              String   @id @default(cuid(2))
  profileId       String   @unique

  enabled         Boolean  @default(false)

  maxStorageBytes BigInt?
  maxFileBytes    BigInt?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  profile Profile @relation(
    fields: [profileId],
    references: [id],
    onDelete: Cascade
  )

  rules SyncRule[]
}
```

`enabled` permet de désactiver complètement la synchronisation pour un profil.

`maxStorageBytes` définit éventuellement un quota spécifique au profil.

`maxFileBytes` définit éventuellement une taille maximale par fichier.

---

# 10. Règles de synchronisation

Les règles servent uniquement à définir les chemins inclus ou exclus de la synchronisation.

```prisma
enum SyncRuleAction {
  INCLUDE
  EXCLUDE
}

model SyncRule {
  id            String         @id @default(cuid(2))
  syncProfileId String

  path          String
  action        SyncRuleAction @default(INCLUDE)
  enabled       Boolean        @default(true)

  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  syncProfile SyncProfile @relation(
    fields: [syncProfileId],
    references: [id],
    onDelete: Cascade
  )

  @@index([syncProfileId])
}
```

Exemple :

```text
INCLUDE saves/**
INCLUDE XaeroWaypoints/**
INCLUDE journeymap/**
INCLUDE config/**

EXCLUDE saves/**/session.lock
EXCLUDE logs/**
EXCLUDE crash-reports/**
```

Les règles d'exclusion doivent être évaluées après les règles d'inclusion.

---

# 11. Validation des chemins

Tous les chemins doivent être relatifs à la racine de l'instance Minecraft.

Valide :

```text
saves/MyWorld/level.dat
```

Interdit :

```text
C:\Users\User\Documents\secret.txt
```

Interdit :

```text
../../../secret.txt
```

Interdit :

```text
/home/user/.ssh/id_rsa
```

L'API doit normaliser le chemin et refuser :

- les chemins absolus ;
- `..` ;
- les chemins sortant de la racine logique ;
- les chemins contenant des séquences invalides ;
- les chemins dépassant une longueur maximale raisonnable.

Les séparateurs doivent être normalisés en `/`.

Exemple :

```text
config\test.toml
```

devient :

```text
config/test.toml
```

---

# 12. SyncFile

`SyncFile` représente l'état distant courant d'un fichier.

```prisma
model SyncFile {
  id        String   @id @default(cuid(2))
  playerId  String
  profileId String

  path      String

  hash      String?
  size      BigInt   @default(0)

  version   Int      @default(1)

  deleted   Boolean  @default(false)

  objectKey String?
  deviceId  String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  player Player @relation(
    fields: [playerId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([playerId, profileId, path])
  @@index([playerId, profileId])
  @@index([hash])
}
```

---

# 13. Hash

SHA-256 doit être utilisé comme algorithme initial.

Format recommandé :

```text
sha256:<hex>
```

Exemple :

```text
sha256:9524a36...
```

Le hash sert à :

- déterminer si deux fichiers sont identiques ;
- éviter les uploads inutiles ;
- vérifier l'intégrité ;
- permettre éventuellement la déduplication ;
- identifier les fichiers dans le manifest.

Le serveur ne doit pas utiliser `mtime` comme source de vérité.

---

# 14. Version

Chaque fichier dispose d'une version entière strictement croissante.

Exemple :

```text
v1
v2
v3
v4
```

Lorsqu'un client modifie un fichier basé sur la version 4, il doit envoyer :

```json
{
  "baseVersion": 4
}
```

Si la version distante actuelle est toujours `4`, la modification peut être acceptée.

Si la version distante est devenue `5`, l'API doit signaler un conflit.

---

# 15. Tombstones

Les suppressions doivent être conservées sous forme de tombstones.

Exemple :

```text
SyncFile

path = config/old.toml
deleted = true
version = 17
```

Le fichier ne doit pas être supprimé immédiatement de PostgreSQL.

Sinon, un appareil hors ligne ne pourrait pas distinguer :

```text
fichier absent car jamais synchronisé
```

de :

```text
fichier supprimé par un autre appareil
```

Les tombstones peuvent être purgés après une durée configurable.

---

# 16. PlayerSyncState

Une révision globale doit être maintenue pour chaque couple :

```text
Player + Profile
```

```prisma
model PlayerSyncState {
  id        String   @id @default(cuid(2))
  playerId  String
  profileId String

  revision  BigInt   @default(0)

  updatedAt DateTime @updatedAt

  player Player @relation(
    fields: [playerId],
    references: [id],
    onDelete: Cascade
  )

  @@unique([playerId, profileId])
}
```

À chaque modification distante :

```text
upload
delete
restore
```

`revision` doit être incrémentée.

---

# 17. Utilité de revision

Le launcher peut demander uniquement :

```http
GET /api/sync/profiles/:profileId/revision
```

Réponse :

```json
{
  "revision": "1828"
}
```

Si la révision locale connue vaut déjà `1828`, aucun manifest n'a besoin d'être téléchargé.

Cela permet d'éviter des réponses volumineuses lorsque plusieurs milliers de fichiers sont synchronisés.

---

# 18. Manifest distant

PostgreSQL constitue le manifest distant.

Il ne faut pas maintenir en parallèle un fichier `manifest.json` serveur.

Endpoint :

```http
GET /api/sync/profiles/:profileId/manifest
```

Réponse :

```json
{
  "revision": "1828",
  "files": {
    "XaeroWaypoints/world/waypoints.txt": {
      "hash": "sha256:abc...",
      "size": "4921",
      "version": 8,
      "deleted": false
    },
    "config/old.toml": {
      "version": 4,
      "deleted": true
    }
  }
}
```

Les `BigInt` doivent être sérialisés sous forme de chaînes si nécessaire.

---

# 19. Endpoint de configuration

Le launcher doit pouvoir récupérer les règles configurées pour un profil.

```http
GET /api/sync/profiles/:profileId/config
```

Réponse :

```json
{
  "enabled": true,

  "limits": {
    "maxStorageBytes": "5368709120",
    "maxFileBytes": "1073741824"
  },

  "rules": [
    {
      "path": "saves/**",
      "action": "INCLUDE"
    },
    {
      "path": "saves/**/session.lock",
      "action": "EXCLUDE"
    },
    {
      "path": "XaeroWaypoints/**",
      "action": "INCLUDE"
    }
  ]
}
```

---

# 20. Object Storage

Le contenu réel des fichiers doit être stocké dans un stockage compatible S3.

Solutions compatibles :

- AWS S3 ;
- Cloudflare R2 ;
- OVH Object Storage ;
- MinIO ;
- autre stockage implémentant l'API S3.

Les fichiers ne doivent pas être stockés dans PostgreSQL.

---

# 21. Configuration environnement

Variables proposées :

```env
SYNC_ENABLED=true

SYNC_S3_ENDPOINT=
SYNC_S3_REGION=
SYNC_S3_BUCKET=

SYNC_S3_ACCESS_KEY=
SYNC_S3_SECRET_KEY=

SYNC_S3_FORCE_PATH_STYLE=false

SYNC_DEFAULT_PLAYER_QUOTA=5368709120
SYNC_DEFAULT_MAX_FILE_SIZE=1073741824

SYNC_SIGNED_URL_TTL=900

SYNC_TOMBSTONE_RETENTION_DAYS=90
```

Les credentials S3 ne doivent jamais être envoyés au launcher.

---

# 22. URLs signées

Le launcher doit accéder au stockage via des URLs temporaires.

```text
Launcher
   │
   │ POST /upload/prepare
   ▼
AdminTool
   │
   │ signed URL
   ▼
Launcher
   │
   │ PUT fichier
   ▼
S3
```

L'AdminTool ne doit pas servir de proxy pour les gros fichiers sauf nécessité particulière.

---

# 23. Upload - préparation

Endpoint :

```http
POST /api/sync/profiles/:profileId/upload/prepare
```

Body :

```json
{
  "path": "saves/MyWorld/region/r.0.0.mca",
  "hash": "sha256:abc123",
  "size": "4194304",
  "baseVersion": 8,
  "deviceId": "device-uuid"
}
```

Le serveur doit vérifier :

1. l'authentification du joueur ;
2. l'existence du `Profile` ;
3. que Sync est activé ;
4. que le chemin est autorisé ;
5. la taille du fichier ;
6. le quota utilisateur ;
7. la validité de `baseVersion` ;
8. que l'appareil appartient au joueur ;
9. l'absence de conflit ;
10. la présence éventuelle de l'objet déjà stocké.

---

# 24. Réponse upload prepare

Cas upload nécessaire :

```json
{
  "uploadRequired": true,
  "uploadId": "cl...",
  "uploadUrl": "https://storage/...",
  "expiresAt": "2026-09-23T14:00:00Z"
}
```

Cas objet déjà présent :

```json
{
  "uploadRequired": false,
  "uploadId": "cl..."
}
```

---

# 25. Upload - commit

Après upload réussi :

```http
POST /api/sync/profiles/:profileId/upload/:uploadId/commit
```

Le serveur doit :

1. vérifier que l'upload appartient au joueur ;
2. vérifier que l'objet existe ;
3. vérifier sa taille si nécessaire ;
4. vérifier de nouveau `baseVersion` ;
5. mettre à jour `SyncFile` dans une transaction ;
6. incrémenter `SyncFile.version` ;
7. incrémenter `PlayerSyncState.revision` ;
8. marquer l'upload comme terminé.

Réponse :

```json
{
  "success": true,

  "file": {
    "path": "saves/MyWorld/region/r.0.0.mca",
    "hash": "sha256:abc123",
    "version": 9
  },

  "revision": "1829"
}
```

---

# 26. Upload session

```prisma
enum SyncUploadState {
  PENDING
  COMMITTED
  EXPIRED
  ABORTED
}

model SyncUpload {
  id          String          @id @default(cuid(2))
  playerId    String
  profileId   String
  deviceId    String

  path        String
  hash        String
  size        BigInt
  baseVersion Int?

  objectKey   String

  state       SyncUploadState @default(PENDING)

  createdAt   DateTime        @default(now())
  expiresAt   DateTime
  committedAt DateTime?

  @@index([playerId, profileId])
  @@index([expiresAt])
}
```

Les uploads expirés doivent être nettoyés périodiquement.

---

# 27. Download

Endpoint :

```http
POST /api/sync/profiles/:profileId/download
```

Body :

```json
{
  "path": "saves/MyWorld/level.dat"
}
```

Réponse :

```json
{
  "path": "saves/MyWorld/level.dat",
  "hash": "sha256:...",
  "size": "3491",
  "version": 14,
  "downloadUrl": "https://storage/..."
}
```

---

# 28. Download multiple

```http
POST /api/sync/profiles/:profileId/download/batch
```

Body :

```json
{
  "paths": [
    "config/a.toml",
    "config/b.toml",
    "XaeroWaypoints/world/a.txt"
  ]
}
```

Réponse :

```json
{
  "files": [
    {
      "path": "config/a.toml",
      "version": 4,
      "downloadUrl": "..."
    },
    {
      "path": "config/b.toml",
      "version": 8,
      "downloadUrl": "..."
    }
  ]
}
```

Une limite doit être imposée au nombre de fichiers par requête.

---

# 29. Suppression

Endpoint :

```http
DELETE /api/sync/profiles/:profileId/file
```

Body :

```json
{
  "path": "config/old.toml",
  "baseVersion": 4,
  "deviceId": "..."
}
```

Le serveur applique :

```text
deleted = true
version++
revision++
```

Le contenu S3 peut être supprimé ultérieurement s'il n'est plus référencé.

---

# 30. Conflits

Un conflit apparaît lorsque le launcher essaie de modifier un fichier à partir d'une version qui n'est plus la version distante actuelle.

```text
Launcher A

baseVersion = 7
→ upload
→ distant = 8


Launcher B

baseVersion = 7
→ upload
```

Le deuxième upload doit être refusé.

```http
409 Conflict
```

```json
{
  "error": "SYNC_CONFLICT",

  "path": "config/test.toml",

  "expectedVersion": 7,
  "currentVersion": 8,

  "remote": {
    "hash": "sha256:...",
    "version": 8,
    "updatedAt": "2026-09-23T13:42:00Z"
  }
}
```

La résolution du conflit appartient principalement au launcher.

---

# 31. Suppression concurrente

La même logique doit s'appliquer aux suppressions.

```text
local baseVersion = 7
remote version = 8
```

Le client ne doit pas pouvoir supprimer silencieusement la version 8.

```http
409 Conflict
```

---

# 32. Transactions

Les opérations modifiant :

```text
SyncFile
PlayerSyncState
SyncUpload
```

doivent utiliser une transaction Prisma.

```ts
await prisma.$transaction(async tx => {
  // Check current file version
  // Update SyncFile
  // Increment PlayerSyncState revision
  // Commit SyncUpload
})
```

---

# 33. Quota

Chaque joueur doit avoir un quota logique.

Exemple :

```text
5 GiB
```

Le quota spécifique du `SyncProfile` peut remplacer le quota global.

Le quota doit être vérifié avant la génération d'une URL d'upload.

Le quota est calculé à partir des fichiers actifs :

```text
SUM(size)
WHERE deleted = false
```

Lors du remplacement d'un fichier, seule la différence de taille doit être prise en compte.

---

# 34. Déduplication

La déduplication peut être supportée.

Object key recommandé :

```text
objects/sha256/<2 premiers caractères>/<hash complet>
```

Exemple :

```text
objects/sha256/a7/a7348f123...
```

Plusieurs `SyncFile` peuvent référencer le même objet.

```text
SyncFile A ─┐
            ├── objects/sha256/a7/a7348...
SyncFile B ─┘
```

La déduplication doit rester une optimisation de stockage.

---

# 35. Garbage Collection

Un objet S3 peut être supprimé lorsqu'aucun fichier actif, aucune version conservée et aucun upload en attente ne le référence.

La suppression doit être différée afin d'éviter les problèmes liés aux opérations concurrentes.

---

# 36. Historique optionnel

Une future version peut conserver quelques versions précédentes.

```prisma
model SyncFileVersion {
  id         String   @id @default(cuid(2))
  syncFileId String

  version    Int
  hash       String
  size       BigInt
  objectKey  String
  deviceId   String?

  createdAt  DateTime @default(now())

  @@unique([syncFileId, version])
}
```

Aucun historique illimité ne doit être activé par défaut.

---

# 37. API appareil

## Register device

```http
POST /api/sync/devices
```

```json
{
  "deviceUuid": "...",
  "name": "Surface Laptop",
  "platform": "win32",
  "arch": "arm64",
  "launcherVersion": "1.4.0"
}
```

Si `deviceUuid` existe déjà pour le joueur, les informations doivent être mises à jour.

---

# 38. Liste des appareils

```http
GET /api/sync/devices
```

Réponse :

```json
{
  "devices": [
    {
      "id": "...",
      "name": "Desktop",
      "platform": "win32",
      "arch": "x64",
      "lastSeenAt": "..."
    },
    {
      "id": "...",
      "name": "Surface Laptop",
      "platform": "win32",
      "arch": "arm64",
      "lastSeenAt": "..."
    }
  ]
}
```

---

# 39. Sécurité

Toutes les routes `/api/sync/*` contenant des données joueur doivent :

- nécessiter une identité vérifiée ;
- déterminer `playerId` côté serveur ;
- vérifier que `deviceId` appartient au joueur ;
- vérifier que le profil existe ;
- vérifier que Sync est activé ;
- vérifier les règles de chemin ;
- appliquer les quotas ;
- ne jamais permettre de sélectionner arbitrairement un autre `playerId`.

Interdit :

```http
GET /api/sync/player/:playerId/manifest
```

Préférer :

```http
GET /api/sync/profiles/:profileId/manifest
```

Le joueur doit être déterminé par l'authentification.

---

# 40. Rate limiting

Les routes Sync doivent avoir un rate limiting adapté.

Les limites doivent être suffisamment larges pour les synchronisations contenant plusieurs milliers de fichiers.

---

# 41. Batch APIs

Pour éviter plusieurs milliers de requêtes HTTP, les opérations suivantes doivent pouvoir fonctionner par lots :

- préparation d'uploads ;
- génération d'URLs de téléchargement.

Exemple :

```http
POST /api/sync/profiles/:profileId/uploads/prepare
```

```json
{
  "files": [
    {
      "path": "journeymap/a.png",
      "hash": "...",
      "size": "1000",
      "baseVersion": 1
    },
    {
      "path": "journeymap/b.png",
      "hash": "...",
      "size": "2000",
      "baseVersion": 4
    }
  ]
}
```

---

# 42. Pagination du manifest

Les manifests très volumineux doivent pouvoir être paginés.

```http
GET /api/sync/profiles/:profileId/manifest?cursor=...
```

Réponse :

```json
{
  "revision": "1892",
  "files": [
    ...
  ],
  "nextCursor": "..."
}
```

Si la révision change pendant la lecture paginée, le launcher peut recommencer la récupération du manifest.

---

# 43. Interface AdminTool

La configuration Sync doit apparaître dans les paramètres du `Profile`.

```text
Profiles
└── Create Edition 3
    ├── General
    ├── Loader
    ├── Files Updater
    └── Synchronization
```

---

# 44. Page Profile > Synchronization

La page doit contenir au minimum :

```text
Player data synchronization

[ ] Enable synchronization
```

Puis :

```text
Storage

Player quota:
[ 5 GB ]

Maximum file size:
[ 1 GB ]
```

Puis une liste des règles.

```text
Synchronization rules

┌───────────────────────────────┬─────────┐
│ Path                          │ Action  │
├───────────────────────────────┼─────────┤
│ saves/**                      │ Include │
│ saves/**/session.lock         │ Exclude │
│ XaeroWaypoints/**             │ Include │
│ journeymap/**                 │ Include │
│ config/**                     │ Include │
└───────────────────────────────┴─────────┘
```

Actions :

```text
Add
Edit
Delete
Enable/Disable
```

---

# 45. Statistiques

Les statistiques liées à la synchronisation doivent être intégrées à la page **Stats** existante de l'AdminTool.

Exemples d'informations à afficher :

```text
Players using Sync       241
Devices                   389
Files                 481 291

Logical storage         287 GB
Physical storage        194 GB

Pending uploads              4
```

Si la déduplication est activée :

```text
Deduplication savings    32 %
```

La page Stats peut également permettre de filtrer ou consulter :

```text
storage by profile
storage by player
number of synchronized files
number of registered devices
conflicts
upload/download activity
```

---

# 46. Liste des joueurs

Une vue liée aux statistiques ou à l'administration Sync peut afficher :

```text
Player              Devices      Storage       Files       Last sync

GaspardG               2          3.7 GB        28 401      2 min ago
Player2                1          812 MB         8 214      1 h ago
```

La recherche doit fonctionner par :

- pseudo Minecraft ;
- UUID Minecraft.

---

# 47. Détail d'un joueur

Informations disponibles :

```text
Minecraft UUID
Storage consumed
Number of files
Number of devices
Last sync
```

Appareils :

```text
Desktop
Windows x64
Last seen 2 min ago

Surface Laptop
Windows arm64
Last seen yesterday
```

Profils :

```text
Create Edition 3
3.2 GB
24 000 files

Vanilla
500 MB
4 400 files
```

---

# 48. Données privées

Par défaut, les administrateurs doivent pouvoir voir :

- la taille ;
- le nombre de fichiers ;
- les chemins nécessaires au support ;
- les appareils ;
- les dates ;
- les versions ;
- l'état des synchronisations.

Le téléchargement du contenu privé d'un utilisateur ne doit pas être accordé implicitement à tout administrateur.

---

# 49. Permissions administrateur

Ajouter des permissions cohérentes avec le système existant.

Exemple :

```text
playerSync.view
playerSync.configure
playerSync.manage
playerSync.deleteData
playerSync.downloadData
```

Les noms exacts doivent respecter le système de permissions actuellement utilisé dans EML-AdminTool.

---

# 50. Suppression des données utilisateur

Un administrateur disposant de la permission correspondante peut supprimer :

```text
un profil synchronisé
```

ou :

```text
toutes les données Sync d'un joueur
```

La suppression doit :

1. supprimer les références PostgreSQL ;
2. programmer les objets inutilisés pour garbage collection ;
3. supprimer les devices si nécessaire ;
4. journaliser l'action administrative.

---

# 51. Audit administratif

Les opérations sensibles doivent être enregistrées.

Exemples :

```text
Sync configuration modified
Player data deleted
Player file downloaded by administrator
Quota changed
Synchronization disabled
```

Informations :

```text
admin user
action
target
timestamp
```

---

# 52. Logs serveur

Logs recommandés :

```text
sync.device.register
sync.manifest.read
sync.upload.prepare
sync.upload.commit
sync.download.prepare
sync.file.delete
sync.conflict
sync.quota.exceeded
sync.storage.error
```

Ne pas logger :

- le contenu des fichiers ;
- les signed URLs complètes ;
- les tokens ;
- les credentials S3.

---

# 53. Codes d'erreur

Format recommandé :

```json
{
  "error": "SYNC_CONFLICT",
  "message": "The remote file has changed."
}
```

Codes minimum :

```text
SYNC_DISABLED
SYNC_PROFILE_NOT_FOUND
SYNC_RULE_NOT_ALLOWED
SYNC_INVALID_PATH
SYNC_FILE_TOO_LARGE
SYNC_QUOTA_EXCEEDED
SYNC_FILE_NOT_FOUND
SYNC_CONFLICT
SYNC_INVALID_DEVICE
SYNC_UPLOAD_NOT_FOUND
SYNC_UPLOAD_EXPIRED
SYNC_STORAGE_ERROR
SYNC_UNAUTHORIZED
```

---

# 54. HTTP status

```text
200 OK
201 Created
204 No Content

400 Invalid request
401 Not authenticated
403 Path/profile forbidden
404 File/profile/upload not found
409 Sync conflict
413 File too large
429 Rate limit
500 Internal error
502/503 Object storage unavailable
```

---

# 55. Stockage content-addressed

Architecture recommandée :

```text
Bucket
└── objects
    └── sha256
        ├── 00
        ├── 01
        ├── ...
        └── af
            └── af81ab...
```

Le chemin réel Minecraft ne doit pas être utilisé directement comme object key.

---

# 56. MIME type

Les fichiers peuvent être traités comme des données binaires génériques.

Valeur par défaut :

```text
application/octet-stream
```

Le MIME type ne doit pas déterminer l'autorisation d'un fichier.

---

# 57. Object integrity

Lors du commit, l'intégrité doit être vérifiée dans la mesure du possible.

Minimum :

```text
expected size == uploaded size
```

Idéal :

```text
expected SHA-256 == stored SHA-256
```

---

# 58. Cleanup des uploads incomplets

Un job périodique doit :

1. chercher les `SyncUpload` expirés ;
2. les passer à `EXPIRED` ;
3. supprimer les objets temporaires inutilisés ;
4. supprimer éventuellement les anciennes entrées.

---

# 59. Maintenance globale

Si EML-AdminTool dispose d'un mode maintenance global, le comportement Sync doit être défini.

Par exemple :

```text
GET manifest/config : autorisé

write operations : bloquées
```

ou toutes les opérations Sync peuvent être bloquées.

---

# 60. Disponibilité du stockage

Si S3 est indisponible :

- les manifests peuvent rester lisibles ;
- les uploads/downloads doivent échouer proprement ;
- aucune modification PostgreSQL ne doit être validée tant que le stockage n'est pas confirmé.

---

# 61. Ordre des opérations d'upload

Correct :

```text
prepare
↓
upload S3
↓
verify
↓
commit PostgreSQL
```

Incorrect :

```text
update PostgreSQL
↓
upload S3
↓
échec
```

---

# 62. Ordre des opérations de suppression

```text
tombstone
↓
revision++
↓
garbage collection différée
```

---

# 63. Monde Minecraft

L'AdminTool ne doit pas avoir de logique spécifique au format `.mca`.

Un monde est traité comme un ensemble de fichiers.

```text
saves/MyWorld/level.dat
saves/MyWorld/region/r.0.0.mca
saves/MyWorld/entities/r.0.0.mca
...
```

Le launcher est responsable de ne pas uploader un monde dans un état incohérent pendant que Minecraft l'utilise.

---

# 64. Maps et waypoints

JourneyMap/Xaero doivent également rester des fichiers standards côté AdminTool.

```text
journeymap/**
XaeroWaypoints/**
```

L'AdminTool n'a pas besoin de comprendre leur format.

---

# 65. Compatibilité multi-plateforme

Les chemins stockés dans la base doivent toujours utiliser `/`.

```text
XaeroWaypoints/world/waypoints.txt
```

Cela garantit un comportement cohérent entre :

```text
Windows x64
Windows ARM64
Linux
macOS
```

---

# 66. Sensibilité à la casse

Les chemins sont stockés dans leur forme réelle.

Le serveur ne doit pas automatiquement transformer tous les chemins en minuscules.

---

# 67. Schéma Prisma synthétique

Les nouveaux modèles principaux sont :

```text
Player
PlayerDevice

SyncProfile
SyncRule

PlayerSyncState

SyncFile
SyncUpload
```

Optionnel :

```text
SyncFileVersion
```

Relations :

```text
Profile
   │
   └── SyncProfile
          │
          └── SyncRule


Player
   ├── PlayerDevice
   ├── PlayerSyncState
   └── SyncFile


Player + Profile
       │
       └── PlayerSyncState


SyncFile
   │
   └── Object Storage object
```

---

# 68. API synthétique V1

## Config

```http
GET /api/sync/profiles/:profile/config
```

## Revision

```http
GET /api/sync/profiles/:profile/revision
```

## Manifest

```http
GET /api/sync/profiles/:profile/manifest
```

## Devices

```http
GET  /api/sync/devices
POST /api/sync/devices
```

## Upload

```http
POST /api/sync/profiles/:profile/upload/prepare
POST /api/sync/profiles/:profile/upload/:id/commit
```

## Batch upload

```http
POST /api/sync/profiles/:profile/uploads/prepare
```

## Download

```http
POST /api/sync/profiles/:profile/download
POST /api/sync/profiles/:profile/download/batch
```

## Delete

```http
DELETE /api/sync/profiles/:profile/file
```

---

# 69. Arborescence serveur proposée

```text
src/
├── lib/
│   └── server/
│       └── sync/
│           ├── auth.ts
│           ├── storage.ts
│           ├── paths.ts
│           ├── rules.ts
│           ├── manifest.ts
│           ├── quota.ts
│           ├── conflicts.ts
│           ├── devices.ts
│           └── errors.ts
│
└── routes/
    └── api/
        └── sync/
            ├── devices/
            │   └── +server.ts
            └── profiles/
                └── [profile]/
                    ├── config/
                    ├── revision/
                    ├── manifest/
                    ├── upload/
                    ├── download/
                    └── file/
```

---

# 70. Service Object Storage

```ts
interface SyncStorage {
  createUploadUrl(input: {
    objectKey: string
    size: bigint
    expiresIn: number
  }): Promise<string>

  createDownloadUrl(input: {
    objectKey: string
    expiresIn: number
  }): Promise<string>

  exists(objectKey: string): Promise<boolean>

  stat(objectKey: string): Promise<{
    size: bigint
  }>

  delete(objectKey: string): Promise<void>
}
```

L'API métier ne doit pas dépendre directement d'un fournisseur S3 précis.

---

# 71. Service Rules

```ts
isPathAllowed(
  profileId: string,
  path: string
): Promise<boolean>
```

La logique doit :

1. normaliser le chemin ;
2. chercher les règles ;
3. déterminer les inclusions ;
4. appliquer les exclusions ;
5. retourner le résultat.

---

# 72. Service Conflict

```ts
checkVersion(
  playerId: string,
  profileId: string,
  path: string,
  baseVersion: number | null
)
```

Cas :

```text
file inexistant + baseVersion null
→ création

file existant + baseVersion correct
→ modification

file existant + baseVersion incorrect
→ conflit

file inexistant + baseVersion fourni
→ conflit
```

---

# 73. Première synchronisation

Si aucun état distant n'existe :

```text
revision = 0
manifest = vide
```

Le launcher décide ensuite des fichiers locaux à envoyer.

Seuls les chemins correspondant aux règles peuvent être synchronisés.

---

# 74. Profile supprimé

Lorsqu'un `Profile` est supprimé :

1. le `SyncProfile` est supprimé ;
2. les nouvelles opérations sont bloquées ;
3. les données associées sont marquées pour suppression ;
4. le garbage collector supprime ensuite les objets inutilisés.

---

# 75. Désactivation temporaire

Désactiver Sync ne doit pas supprimer les données.

```text
enabled = false
```

bloque simplement les nouvelles synchronisations.

---

# 76. Quota global

Une configuration globale doit pouvoir définir :

```text
Default player quota
Default maximum file size
Signed URL TTL
Tombstone retention
```

Une configuration spécifique au profil peut remplacer ces valeurs.

---

# 77. Métriques

Métriques utiles :

```text
sync_players_total
sync_devices_total
sync_files_total

sync_logical_bytes
sync_physical_bytes

sync_uploads_total
sync_downloads_total
sync_conflicts_total

sync_upload_failures_total
sync_storage_failures_total
```

Ces métriques peuvent alimenter la page Stats existante et éventuellement Prometheus/Grafana.

---

# 78. Statistiques privées

Les métriques publiques ne doivent pas exposer inutilement :

```text
path
minecraft UUID
```

comme labels.

---

# 79. Performance

Les requêtes doivent utiliser :

```text
@@index([playerId, profileId])
```

et :

```text
@@unique([playerId, profileId, path])
```

afin d'éviter les recherches linéaires inutiles.

---

# 80. Manifest et mémoire

L'API doit éviter de charger inutilement de très gros manifests en mémoire.

La pagination peut être utilisée lorsque le volume devient important.

---

# 81. Migration

L'ajout de Sync ne doit pas modifier le comportement des installations existantes.

Après migration :

```text
SyncProfile inexistant
```

ou :

```text
enabled = false
```

signifie :

```text
Sync disabled
```

Aucun stockage S3 ne doit être requis tant que la fonctionnalité n'est pas activée.

---

# 82. Déploiement Docker

Si :

```text
SYNC_ENABLED=false
```

EML-AdminTool doit fonctionner sans configuration S3.

Si :

```text
SYNC_ENABLED=true
```

les variables S3 nécessaires doivent être validées.

---

# 83. Évolution EML-Lib

Les endpoints doivent être conçus pour être consommés directement par EML-Lib.

Conceptuellement :

```ts
const sync = new SyncManager({
  adminToolUrl,
  profile,
  account
})

await sync.pull()

await launcher.launch()

await sync.push()
```

Le protocole HTTP ne doit pas dépendre de l'interface Web de l'AdminTool.

---

# 84. Flux complet d'upload

```text
Launcher
   │
   │ Scan local
   ▼
Local manifest
   │
   │ Compare local / base / remote
   ▼
File needs upload
   │
   │ POST /upload/prepare
   ▼
AdminTool
   │
   ├── authenticate player
   ├── validate device
   ├── validate profile
   ├── validate path
   ├── validate quota
   └── validate version
   │
   │ signed PUT URL
   ▼
Launcher
   │
   │ PUT binary
   ▼
Object Storage
   │
   ▼
Launcher
   │
   │ POST /upload/:id/commit
   ▼
AdminTool
   │
   ├── verify object
   ├── update SyncFile
   ├── version++
   ├── revision++
   └── commit transaction
```

---

# 85. Flux complet de download

```text
Launcher
   │
   │ GET revision
   ▼
AdminTool
   │
   │ revision differs
   ▼
Launcher
   │
   │ GET manifest
   ▼
AdminTool
   │
   ▼
Three-way comparison
   │
   ├── unchanged
   ├── upload
   ├── conflict
   └── download
          │
          │ POST /download
          ▼
      AdminTool
          │
          │ signed GET URL
          ▼
      Launcher
          │
          ▼
      Object Storage
```

---

# 86. Flux conflit

```text
Base locale
version 4
hash AAA

Local
hash BBB

Remote
version 5
hash CCC
```

Le launcher tente :

```text
baseVersion = 4
```

AdminTool constate :

```text
currentVersion = 5
```

Réponse :

```text
409 SYNC_CONFLICT
```

L'AdminTool ne choisit pas automatiquement quelle version écraser.

---

# 87. Critères d'acceptation V1

La V1 est considérée fonctionnelle lorsque :

- [ ] un administrateur peut activer Sync pour un Profile ;
- [ ] un administrateur peut ajouter des règles d'inclusion et d'exclusion ;
- [ ] un launcher authentifié peut enregistrer un appareil ;
- [ ] un launcher peut récupérer la configuration Sync ;
- [ ] un launcher peut récupérer une révision ;
- [ ] un launcher peut récupérer un manifest ;
- [ ] un launcher peut préparer un upload ;
- [ ] un launcher peut uploader directement vers S3 ;
- [ ] un launcher peut commit un upload ;
- [ ] un launcher peut récupérer une URL de téléchargement ;
- [ ] un launcher peut créer un tombstone ;
- [ ] les versions sont incrémentées ;
- [ ] les conflits sont détectés avec `baseVersion` ;
- [ ] la révision globale est incrémentée ;
- [ ] les quotas sont appliqués ;
- [ ] un joueur ne peut pas accéder aux données d'un autre joueur ;
- [ ] les chemins non autorisés sont refusés ;
- [ ] les fichiers ne transitent pas par PostgreSQL ;
- [ ] Sync peut être désactivé sans casser les autres fonctionnalités EML.

---

# 88. Ordre d'implémentation recommandé

## Phase 1 - Core database

Créer :

```text
Player
PlayerDevice
SyncProfile
SyncRule
PlayerSyncState
SyncFile
SyncUpload
```

## Phase 2 - Configuration AdminTool

Implémenter :

```text
Profile > Synchronization
```

avec :

```text
Enable
Quota
Max file size
Rules
```

## Phase 3 - Player identity

Créer la couche permettant aux endpoints Sync de déterminer :

```text
authenticatedPlayer
```

## Phase 4 - Storage

Ajouter :

```text
S3 client
signed upload URLs
signed download URLs
object stat
delete
```

## Phase 5 - Manifest

Implémenter :

```text
/config
/revision
/manifest
```

## Phase 6 - Upload

Implémenter :

```text
prepare
PUT S3
commit
```

## Phase 7 - Download

Implémenter :

```text
single download
batch download
```

## Phase 8 - Delete

Implémenter :

```text
tombstones
revision increment
```

## Phase 9 - Stats

Ajouter à la page Stats existante :

```text
storage usage
players
devices
files
conflicts
uploads
downloads
errors
```

## Phase 10 - Optimisations

Ajouter si nécessaire :

```text
batch upload
version history
deduplication
garbage collection
advanced metrics
```

---

# 89. Résumé architectural

```text
                    EML AdminTool
                         │
              ┌──────────┴──────────┐
              │                     │
         PostgreSQL            Object Storage
              │                     │
         metadata                 binaries
              │                     │
              └──────────┬──────────┘
                         │
                      Sync API
                         │
                         │ HTTPS
                         ▼
                      EML Lib
                         │
                         ▼
                     Minecraft
```

Le serveur conserve :

```text
player
profile
path
hash
version
device
object location
```

Le stockage objet conserve :

```text
actual file bytes
```

Le launcher conserve :

```text
local current state
+
last synchronized state
```

La comparaison `base / local / remote` et la résolution des conflits restent principalement côté launcher.

L'AdminTool joue le rôle de :

```text
authentication authority
metadata authority
version authority
conflict guard
storage broker
administration interface
```

L'AdminTool ne cherche pas à comprendre ou fusionner directement les formats internes des fichiers Minecraft.