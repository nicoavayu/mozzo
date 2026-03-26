# Mozzo

Mozzo es una base para pedidos de restaurante con dos superficies:

- frontend React/Vite para cliente por mesa y panel admin
- backend Node/Express + Socket.IO + SQLite

El flujo core cubierto hoy es:

1. publicar un menú versionado sin borrar historial
2. tomar pedidos por mesa
3. ver y actualizar pedidos desde admin
4. mantener histórico renderizable desde snapshots en `order_items`

OCR de menú existe como feature opcional, pero no forma parte del core testable ni de la CI.

## Requisitos

- Node `22.x`
- npm `10+`
- Python `3.x` solo si vas a usar importación de menú por foto

La versión de runtime soportada en el repo está fijada en `.nvmrc`.

## Setup Rápido

Primer arranque recomendado desde un clone limpio:

```bash
nvm use
npm run setup
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run db:migrate
npm run db:seed
npm run dev
```

Notas:

- `npm run db:migrate` crea una base vacía con schema actualizado.
- `npm run db:seed` agrega un menú de ejemplo para probar rápido. No crea pedidos.
- Si querés una base vacía sin menú de ejemplo, corré solo `npm run db:migrate`.

## Scripts

En la raíz:

```bash
npm run setup        # instala frontend + backend con npm ci
npm run dev          # levanta backend y frontend en paralelo
npm run dev:backend
npm run dev:frontend
npm run db:migrate
npm run db:seed
npm run build        # build del frontend
npm run check        # check backend + lint/build frontend
npm run smoke        # smoke core end-to-end sin OCR
```

## Variables de Entorno

### Backend

Definidas en `backend/.env.example`.

Obligatorias en uso real:

- `ADMIN_PASSWORD`: password del panel admin
- `ADMIN_TOKEN_SECRET`: secreto para firmar tokens admin

Opcionales con default local:

- `PORT`: default `3000`
- `DATABASE_PATH`: default `./database.sqlite`
- `UPLOAD_DIR`: default `./uploads`
- `FRONTEND_URL`: default `http://localhost:5173`
- `PYTHON_BIN`: default `./venv/bin/python3`
- `PROCESS_MENU_SCRIPT`: default `./process_menu.py`

Notas:

- El backend carga `backend/.env` automáticamente.
- Si faltan `ADMIN_PASSWORD` o `ADMIN_TOKEN_SECRET`, el login admin no funciona.
- `DATABASE_PATH`, `UPLOAD_DIR`, `PYTHON_BIN` y `PROCESS_MENU_SCRIPT` se resuelven desde el directorio `backend`.

### Frontend

Definidas en `frontend/.env.example`.

Opcionales con default local:

- `VITE_API_URL`: default `http://localhost:3000`

Vite carga `frontend/.env` automáticamente.

## Migraciones y Seed

Las migraciones viven en `backend/migrations`.

Comandos:

```bash
npm run db:migrate
npm run db:seed
```

Qué hacen:

- `db:migrate`: aplica schema base, migraciones legacy y extensiones de snapshots
- `db:seed`: publica un menú de ejemplo solo si la tabla `menus` está vacía

## Smoke Core

El smoke vive en `backend/scripts/smoke.js` y cubre:

- boot del backend
- `GET /api/health`
- login admin
- protección de rutas admin
- publicación de menú
- creación de pedido con contrato actual
- realtime mesa/admin
- cambio de estado
- persistencia de snapshots
- recuperación de pedido activo por mesa

No cubre OCR ni depende de archivos persistidos en el repo.

Ejecución:

```bash
npm run smoke
```

## Flujo de Desarrollo Local

1. levantar dependencias con `npm run setup`
2. copiar `.env.example` a `.env` en `backend` y `frontend`
3. correr `npm run db:migrate`
4. opcionalmente correr `npm run db:seed`
5. levantar `npm run dev`
6. abrir:
   - cliente: `http://localhost:5173/:tableId`
   - admin: `http://localhost:5173/admin`
   - backend: `http://localhost:3000`

Comandos útiles:

```bash
npm run check
npm run smoke
```

## Backup y Restore de SQLite

Script incluido:

- `backend/scripts/backup-sqlite.sh`

Uso:

```bash
sh backend/scripts/backup-sqlite.sh
sh backend/scripts/backup-sqlite.sh /ruta/origen.sqlite /ruta/destino.sqlite
```

Comportamiento:

- si existe `backend/.env`, toma `DATABASE_PATH` desde ahí
- si no, usa `backend/database.sqlite`
- crea una copia consistente usando la API de backup de SQLite, sin depender del binario `sqlite3`

Restore manual básico:

1. detener el backend
2. copiar el backup sobre la base activa
3. volver a arrancar el backend
4. si el código avanzó desde ese backup, correr `npm run db:migrate`

Ejemplo:

```bash
cp backend/backups/mozzo-YYYYMMDD-HHMMSS.sqlite backend/database.sqlite
npm run db:migrate
npm run dev:backend
```

Si querés preservar uploads históricos, respaldá `UPLOAD_DIR` por separado. El script incluido solo cubre SQLite.

## Perfil de Deploy Soportado

Perfil soportado hoy:

- una sola instancia de backend
- disco persistente para `DATABASE_PATH` y `UPLOAD_DIR`
- frontend estático servido por cualquier hosting estático

No es un perfil multi-instancia todavía:

- SQLite es la base principal
- Socket.IO usa rooms en memoria del proceso

Configuración de deploy mínima:

- backend con `ADMIN_PASSWORD`, `ADMIN_TOKEN_SECRET`, `FRONTEND_URL`
- volumen persistente montado para DB y uploads
- frontend buildado con `VITE_API_URL` apuntando al backend público

## CI

La workflow mínima vive en `.github/workflows/ci.yml` y corre:

1. instalación con `npm ci`
2. build del frontend
3. `check` del backend
4. smoke core sin OCR

## Estado del Repo

El repo ya no depende de un `database.sqlite` versionado ni de assets/template de Vite no usados. El estado reproducible esperado sale de:

- `npm run setup`
- `npm run db:migrate`
- `npm run db:seed` opcional
